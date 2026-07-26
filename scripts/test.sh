#!/usr/bin/env sh
# One entry point for the OpenFrame test suites.
#
#   scripts/test.sh unit      vitest unit + component projects
#   scripts/test.sh api       vitest api project (needs the test database)
#   scripts/test.sh e2e       playwright specs (needs the test database)
#   scripts/test.sh all       unit, then api, then e2e
#   scripts/test.sh mutation  StrykerJS over the authorization modules (slow)
#
# Run the api and e2e suites one at a time, never side by side. They share one
# database, and the api suite empties every table after each of its tests, so a
# concurrent e2e run loses the rows it seeded and fails for no real reason.
# `all` runs them in sequence for exactly this reason.
#
# Every suite runs inside a container, so no package manager runs on the host.
# TESTING.md section 8 documents the raw podman commands this wraps.

set -eu

bun_image='docker.io/oven/bun:alpine'
# StrykerJS is the one thing here that cannot run under bun: its instrumenter and
# its vitest runner both want a node runtime, and @stryker-mutator/core declares
# `engines.node >= 20`. `bun run test:mutation` would resolve the bin and then
# execute it under bun, so the mutation mode below uses node explicitly.
node_image='docker.io/library/node:22-alpine'
# Pinned to the installed @playwright/test version. The image carries the
# matching browser build, and Playwright refuses a mismatched pair. Microsoft
# publishes the image some time after the npm release, so check the tag exists
# before bumping either half:
#   curl -sI https://mcr.microsoft.com/v2/playwright/manifests/v1.61.1-noble
playwright_image='mcr.microsoft.com/playwright:v1.61.1-noble'
# Shared podman network, so the runner container reaches Postgres by service
# name instead of a published port.
network='openframe-test'

# Resolve the repo root from this script's own location, so the script behaves
# the same from any working directory.
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH='' cd -- "$script_dir/.." && pwd)

compose_file="$repo_root/docker-compose.test.yml"
playwright_config="$repo_root/playwright.config.ts"
env_test="$repo_root/.env.test"
env_test_example="$repo_root/.env.test.example"

# Attach a TTY only when there is one, so the script also works from a hook,
# a pipe, or a CI runner.
if [ -t 1 ]; then
  tty_flag='-t'
else
  tty_flag=''
fi

usage() {
  cat <<'EOF'
Usage: scripts/test.sh <unit|api|e2e|all|mutation>

  unit      Unit and component suites. No database, no browser.
  api       API integration suites. Starts the disposable test Postgres first.
  e2e       Playwright end-to-end specs. Starts the test Postgres and MinIO
            first, then builds and starts the app itself on port 3100.
  all       unit, then api, then e2e.
  mutation  StrykerJS over the authorization and validation modules listed in
            stryker.config.json. Minutes, not seconds, and not part of `all`:
            it answers "which of my tests cannot fail", which is a question you
            ask after writing a batch of them, not on every run. The report
            lands in reports/mutation/index.html.

The containers keep running afterwards so the next run is fast. Stop them
with: podman compose -f docker-compose.test.yml --profile e2e down -v
EOF
}

say() {
  printf '\n==> %s\n' "$1"
}

# Each argument is printed on its own line, so a diagnostic can carry the fix
# right under the problem.
die() {
  printf 'scripts/test.sh: %s\n' "$1" >&2
  shift
  for line in "$@"; do
    printf '  %s\n' "$line" >&2
  done
  exit 1
}

show() {
  printf '+'
  for word in "$@"; do
    # Quote the arguments that contain spaces, so the printed line reads like
    # something you could paste back into a shell.
    case $word in
      *' '*) printf " '%s'" "$word" ;;
      *) printf ' %s' "$word" ;;
    esac
  done
  printf '\n'
}

# Prints the command, runs it, and exits with the command's own status so the
# caller (a hook, CI, or a shell) sees the real result.
run_cmd() {
  show "$@"
  set +e
  "$@"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    printf '\nscripts/test.sh: %s exited with %s\n' "$1" "$status" >&2
    exit "$status"
  fi
}

# The tty_flag expansion below stays quoted when set and disappears entirely
# when empty, which a plain "$tty_flag" cannot do (it would pass an empty
# argument to podman).
run_in_bun_image() {
  bun_network=$1
  bun_command=$2
  if [ -n "$bun_network" ]; then
    run_cmd podman run --rm ${tty_flag:+"$tty_flag"} --network "$bun_network" \
      -v "$repo_root:/workspace:z" -w /workspace "$bun_image" sh -c "$bun_command"
  else
    run_cmd podman run --rm ${tty_flag:+"$tty_flag"} \
      -v "$repo_root:/workspace:z" -w /workspace "$bun_image" sh -c "$bun_command"
  fi
}

# --ipc=host is Playwright's documented requirement for Chromium in a
# container; without it Chromium runs out of shared memory on larger pages.
run_in_playwright_image() {
  run_cmd podman run --rm ${tty_flag:+"$tty_flag"} --ipc=host --network "$network" \
    -v "$repo_root:/workspace:z" -w /workspace "$playwright_image" sh -c "$1"
}

require_compose_file() {
  [ -f "$compose_file" ] && return 0
  die "docker-compose.test.yml not found at $compose_file." \
    'The test database ships with Phase 2 of TESTING.md (section 5), so the api' \
    'and e2e suites cannot run until that lands.'
}

# Creates .env.test rather than telling the reader to copy it.
#
# The file is gitignored but holds nothing secret: it is the throwaway postgres
# and minio credentials out of docker-compose.test.yml, written for exactly the
# containers this script starts. There is no decision for anyone to make.
#
# It is also a safety measure. bun loads a plain `.env` into the environment on
# its own, so with no .env.test the suites inherit whatever DATABASE_URL a
# developer keeps in .env, which is usually a real deployment. The api setup
# builds its schema with `prisma db push --accept-data-loss` and truncates every
# table between tests. tests/helpers/test-database.ts refuses to run against a
# database that is not named as a test one, and this keeps that refusal from
# being something anybody has to see.
ensure_env_test() {
  [ -f "$env_test" ] && return 0
  if [ ! -f "$env_test_example" ]; then
    die "Neither $env_test nor $env_test_example exists." \
      'Both ship with Phase 2 of TESTING.md (section 5).'
  fi
  cp "$env_test_example" "$env_test"
  say 'created .env.test from .env.test.example'
}

require_playwright_config() {
  [ -f "$playwright_config" ] && return 0
  die "playwright.config.ts not found at $playwright_config." \
    'The end-to-end suite is Phase 3 of TESTING.md (section 6) and has not' \
    'landed yet, so there is nothing for playwright to run.'
}

ensure_network() {
  if podman network exists "$network"; then
    return 0
  fi
  say "creating the $network podman network"
  run_cmd podman network create "$network"
}

# `podman compose up -d --wait` is not usable here. With podman-compose 1.6.0 as
# the provider it does not block on the healthcheck at all when the service is
# starting, and worse, it never returns when the service is already up and
# healthy: an e2e run was observed wedged on it for 22 minutes with nothing to
# show for it. So every service is started without --wait and its readiness is
# polled here instead.
wait_for_test_db() {
  say 'waiting for postgres-test to accept connections'
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if podman compose -f "$compose_file" exec -T postgres-test \
      pg_isready -U openframe -d openframe_test >/dev/null 2>&1; then
      printf 'postgres-test is ready\n'
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  die 'postgres-test did not become ready within 60 seconds.' \
    "Inspect it with: podman compose -f $compose_file logs postgres-test"
}

wait_for_test_storage() {
  say 'waiting for minio-test to report healthy'
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if podman exec openframe-minio-test mc ready local >/dev/null 2>&1; then
      printf 'minio-test is ready\n'
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  die 'minio-test did not become ready within 60 seconds.' \
    "Inspect it with: podman compose -f $compose_file logs minio-test"
}

start_test_db() {
  ensure_network
  say 'starting the test database'
  run_cmd podman compose -f "$compose_file" up -d postgres-test
  wait_for_test_db
}

# Object storage for the direct video upload flow. The browser PUTs the file
# straight at the presigned URL, so this has to be real; there is nothing to
# mock at that boundary from inside a browser.
#
# minio-test-init is a one-shot container that creates the bucket. Nothing at
# runtime does: ensureR2BucketExists() lives in scripts/self-host-bootstrap.ts,
# not on the request path.
start_test_storage() {
  say 'starting object storage for the upload flow'
  # Asking compose to start a container that is already up prints a red
  # `cannot start an already running container` error and keeps going, which
  # reads like a failure in the log of an otherwise clean run. Skip the call
  # instead.
  if podman exec openframe-minio-test mc ready local >/dev/null 2>&1; then
    printf 'minio-test is already running\n'
  else
    run_cmd podman compose -f "$compose_file" --profile e2e up -d minio-test
    wait_for_test_storage
  fi
  # --no-deps: the init container declares depends_on minio-test, and without
  # this compose tries to start that dependency again and prints the same
  # spurious `already running` error the guard above exists to avoid.
  run_cmd podman compose -f "$compose_file" --profile e2e up --no-deps minio-test-init
}

# --frozen-lockfile keeps a test run from rewriting bun.lock as a side effect.
install_step='bun install --frozen-lockfile'

run_unit() {
  say 'unit and component suites'
  run_in_bun_image '' "$install_step && bun run test"
}

run_mutation() {
  say 'mutation testing'
  # No install step: the node image has npm, and letting it touch node_modules
  # that bun installed is a good way to end up with two package managers
  # disagreeing. Run `scripts/test.sh unit` once first if the tree is cold.
  run_cmd podman run --rm ${tty_flag:+"$tty_flag"} \
    -v "$repo_root:/workspace:z" -w /workspace "$node_image" \
    node node_modules/@stryker-mutator/core/bin/stryker.js run
}

run_api() {
  say 'api suites'
  require_compose_file
  ensure_env_test
  start_test_db
  run_in_bun_image "$network" "$install_step && bun run test:api"
}

run_e2e() {
  say 'end-to-end specs'
  require_compose_file
  require_playwright_config
  ensure_env_test
  start_test_db
  start_test_storage
  # The official Playwright image carries node and the browsers but not bun.
  # bun is needed for `bun run test:e2e`; the web server inside
  # playwright.config.ts runs next through node_modules/.bin, so it works under
  # either runtime. bun is installed into the throwaway container, never on the
  # host, and `oven-sh/setup-bun` cannot be used because the image has no unzip.
  #
  # Playwright starts and stops the app itself (`webServer`), on port 3100 so it
  # cannot attach to a dev server on 3000. The build output lands in the mounted
  # .next, which is what keeps the second run fast.
  run_in_playwright_image \
    "npm install --global --silent bun && $install_step && bun run test:e2e"
}

case "${1-}" in
  -h | --help | help)
    usage
    exit 0
    ;;
esac

if [ "$#" -ne 1 ]; then
  printf 'scripts/test.sh: exactly one mode is required\n\n' >&2
  usage >&2
  exit 64
fi

if ! command -v podman >/dev/null 2>&1; then
  die 'podman was not found on PATH.' \
    'Every suite runs in a container, so podman is required.'
fi

case "$1" in
  unit)
    run_unit
    ;;
  api)
    run_api
    ;;
  e2e)
    run_e2e
    ;;
  all)
    run_unit
    run_api
    run_e2e
    ;;
  mutation)
    run_mutation
    ;;
  *)
    printf 'scripts/test.sh: unknown mode "%s"\n\n' "$1" >&2
    usage >&2
    exit 64
    ;;
esac
