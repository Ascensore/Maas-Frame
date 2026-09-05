# Internal deployment

This repository is **https://github.com/Ascensore/Maas-Frame**. It is for
Ascensore internal use only. Do not sell this, host it as a public product, or
put another product’s name or marks on anything public-facing.

Git remotes and pull requests stay on this repository. There is no second remote
to rebase from. Create PRs with:

```bash
gh pr create --repo Ascensore/Maas-Frame --base master
```

Never open a compare URL that defaults to a different GitHub project as the
base. `worker/` and `nle/` are independent packages with their own lockfiles.
Do not turn the repo into a Bun workspace: that would make the root `bun.lock`
a workspace lockfile and conflict on every dependency bump.

## Required env for an internal host

Copy `.env.example` to `.env` and set real secrets. The values that matter here:

| Variable                                    | Value                                              | Why                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENFRAME_ENABLE_STRIPE`                   | `false`                                            | Billing is wired into authorization. Off, every account has access and no trial caps apply.                                                                                                                                                                                                                               |
| `OPENFRAME_MAX_VIDEO_UPLOAD_BYTES`          | set explicitly (default 100 GiB in the example)    | With Stripe off there is no quota, so the code falls back to a flat **5 GiB** per file unless this is set.                                                                                                                                                                                                                |
| `OPENFRAME_ENABLE_S3_VIDEO_UPLOADS`         | `true`                                             | Direct uploads to R2 / S3-compatible storage.                                                                                                                                                                                                                                                                             |
| `OPENFRAME_ENABLE_BUNNY_UPLOADS`            | `false`                                            | Only one direct-upload backend can be active.                                                                                                                                                                                                                                                                             |
| `OPENFRAME_REQUIRE_INVITE_CODE`             | `true`                                             | Registration stays closed. Set `INVITE_CODE`.                                                                                                                                                                                                                                                                             |
| `OPENFRAME_ALLOWED_SIGNUP_EMAILS`           | comma-separated addresses, or empty                | When set, only these addresses can self-register with the invite code.                                                                                                                                                                                                                                                    |
| `OPENFRAME_ENABLE_ANALYTICS`                | `false`                                            | Leave the marketing funnel off.                                                                                                                                                                                                                                                                                           |
| `OPENFRAME_ENABLE_AGENTS`                   | `false`                                            | In-product review agents. Off until you want them; a non-mock model sends transcript text off-instance.                                                                                                                                                                                                                   |
| `OPENFRAME_AGENT_MODEL`                     | `mock`                                             | `mock` never leaves the process. Cloud models are AI SDK ids such as `openai/gpt-4.1-mini`.                                                                                                                                                                                                                               |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | your Workspace OAuth app                           | SSO for the company domain. Restrict the OAuth client to your domain in Google Cloud.                                                                                                                                                                                                                                     |
| `OPENFRAME_ENABLE_TRANSCRIPTION`            | `true`                                             | Enqueue transcription after a version lands. On (anything but a literal `false`), a rough cut also waits for its clips' transcripts — up to **two hours** — and fails with a message naming the clip rather than falling back to detecting speech from audio energy. Off, the old fallback returns with a 15-minute wait. |
| `OPENFRAME_TRANSCRIPTION_PROVIDER`          | `whisper-local` (default), `deepgram`, or `openai` | Pluggable. Cloud providers need their API keys.                                                                                                                                                                                                                                                                           |
| `OPENFRAME_ENABLE_PROXY_TRANSCODE`          | `true`                                             | After probe, transcode ProRes/DNx/HEVC/etc. to an H.264 AAC MP4 the browser can play.                                                                                                                                                                                                                                     |

Vercel hosts the Next.js app at `https://maas-frame.vercel.app`. It does not
run ffmpeg. Transcription and review proxies need a separate **media worker**
with `DATABASE_URL` pointing at the same Postgres as the app, plus R2
credentials. In-product review agents need a second long-running process,
`bun run agent-worker`, on that same host. Docker Compose starts it as
`agent-worker`.

Production Vercel builds run committed Prisma migrations before building the
application (`vercel.json` -> `bun run vercel-build`). A migration failure stops
the deployment before Vercel can route traffic to code generated from a newer
schema. Preview builds skip this step and must not point at the production
database. Keep production migrations backward-compatible with the currently
serving release: add/expand first, deploy readers and writers, and only remove
old columns or values in a later release.

`OPENFRAME_ENABLE_AGENTS` defaults to **false**. A non-`mock`
`OPENFRAME_AGENT_MODEL` (`openai/…`, `anthropic/…`, `google/…`) sends
transcript and comment text to that provider. Leave the model at `mock` unless
you intend that egress.

On Vercel, use the Supabase pooler (IPv4), not the direct
`db.<ref>.supabase.co` host, which is IPv6-only. `DATABASE_URL` can retain the
**session pooler** address on port 5432 for Prisma migrations. The application's
Prisma pool automatically uses **transaction pooling** on port 6543 for that
same Supabase pooler host when `VERCEL=1`. Credentials, database and TLS options
are preserved. Other database hosts and workers retain their configured URL.

The session pooler admits only `pool_size` clients at once (15 on the current
compute). Even one connection per Vercel isolate can exceed that cap, causing
`EMAXCONNSESSION` while saving an uploaded video. Transaction pooling releases
the backend between transactions. The application still caps each isolate at
one client and closes idle clients after 5 seconds (`lib/db-pool.ts`); idle
timers alone cannot protect session slots when Vercel freezes an isolate.

Live comments use `LISTEN`/`NOTIFY` only off Vercel (Docker / a long-running
Node process). A dedicated `LISTEN` connection per open review page used to pin
a pooler slot for up to 300 seconds and exhausted the cap. On Vercel the live
route keeps the SSE open without `LISTEN`; the client already polls comments
every 10s. The media worker also caps its `pg` and pg-boss pools at 2 each so
it cannot take the remaining slots.

A blank Postgres cannot be bootstrapped with `bun run db:migrate` alone (the
migration history was applied with `db push` and then marked applied). Use
`scripts/docker-db-bootstrap.ts` against a new database, then apply any extra
indexes the script prints.

## Services

`docker compose up --build` starts:

- the Next.js app
- PostgreSQL
- MinIO
- the media worker (ffmpeg + job poller)
- the agent worker (polls `agent_runs`, posts agent-labeled comments)

The worker probes uploaded files for a rational frame rate, transcodes a
review proxy when the master will not play in a browser (and burns a
`CONFIDENTIAL · {project}` label into **new** proxies when the project
watermark is on), and, when transcription is enabled, extracts audio and
transcribes it.

It also burns subtitles into a new version on request (`BURN_SUBTITLES`).
That job draws the text with libass, which finds a font family by name
through fontconfig and silently substitutes another when it cannot, so
`worker/Dockerfile` installs `fontconfig`, `fonts-dejavu-core`,
`fonts-liberation2`, `fonts-roboto` and `fonts-open-sans` and asserts every
offered family with `fc-match` at build time. A worker image built without
those packages produces burned-in text in the wrong typeface rather than a
failed job, which is why the assertion fails the build instead.

## Media worker host

The production media worker does not run on Vercel. It is a Docker container
on the Ascensore VPS (`srv1637595`, log in as root), started from a checkout
of this repository at `/opt/maas-frame/app`. Other unrelated services live in
`/docker/*` on the same box; leave them alone.

How it is wired:

- The compose file is `docker-compose.worker.yml` in that checkout, untracked
  by git. It defines one service, `worker`, built from `worker/Dockerfile`
  with `env_file: .env.worker`. The container is named `app-worker-1` (Docker
  Compose derives the `app` prefix from the directory name).
- The committed `docker-compose.yml` is the self-hosting bundle (app, Postgres,
  MinIO, workers) and expects `.env.docker`, which does not exist there. Any
  `docker compose` command on that host must pass
  `-f docker-compose.worker.yml`.
- `DATABASE_URL` in `.env.worker` points at the production Supabase Postgres,
  the same database Vercel migrates on deploy. The worker has no migrations of
  its own.
- `worker/Dockerfile` copies `lib/rough-cut`, `lib/media-job-queue.ts`,
  `lib/timecode.ts`, `lib/folders.ts` and `lib/export-file-names.ts` into the
  image at build time. A change to any of those files, or to `worker/`, is
  not live until the image is rebuilt. Merging to master updates Vercel only.
- `OPENFRAME_ENABLE_ROUGH_CUT` is read by the app, not the worker; set it in
  Vercel (Settings -> Environment Variables, Production) and redeploy. The
  worker processes whatever jobs the app enqueues.
- Storage region: the worker reads `AWS_REGION` or `S3_REGION`. Cloudflare R2
  accepts `auto`; Supabase or MinIO storage need a real region (`eu-west-1`).
  Set it in `.env.worker` rather than editing `worker/src/index.ts` on the
  server, which blocks the next `git pull`.
- Diarization stays optional. With `OPENFRAME_ENABLE_DIARIZATION=false` the
  multicam assembler attributes speakers by per-camera loudness; turning it on
  needs `HUGGINGFACE_TOKEN` and the pyannote licence acceptance.

Update after merging to master:

```bash
ssh root@srv1637595
cd /opt/maas-frame/app
git status --short --branch          # expect "## master...origin/master", no " M" lines
git pull --ff-only origin master
docker compose -f docker-compose.worker.yml up -d --build
docker compose -f docker-compose.worker.yml logs --tail=30 worker
```

If `git status` shows a modified tracked file, inspect it with `git diff`;
if master already covers the change, `git checkout -- <file>` before pulling,
otherwise `git stash push <file>` and port the change into a PR.

The first rebuild after a base-image change takes about five minutes
(ffmpeg, PyTorch and the Whisper packages); later rebuilds reuse those
layers. `restart: unless-stopped` brings the container back after a reboot.

Verify the running image is current:

```bash
docker compose -f docker-compose.worker.yml exec worker ls lib/rough-cut/markers.ts
```

That file only exists in images built from master at or after September
2026; a `No such file` answer means the container was not rebuilt. In the
log, a healthy worker prints `job <id> <TYPE> succeeded` lines and no Python
tracebacks. Then start a rough cut from the app: a run made by the current
worker stores `brief_snapshot` on `rough_cuts` and, once its transcript is
in, `cuts` and `markers` inside `decisions`.

## After pulling master

If you are not on the already-bootstrapped Maas-Frame database, apply schema
to the **app** database (the test database is separate):

```bash
bun run db:migrate
```

Run it after this pull whichever database you are on:
`20260907110000_transcript_first_editing` adds the `BURN_SUBTITLES` job kind
and the `script`, `overrides`, `rendered_overrides` and `rendered_decisions`
columns on `rough_cuts`. It only adds, so it is safe to apply before the app
that reads them is deployed; the media worker needs it before it can lease a
burn-in job at all.

**Rebuild and redeploy the media worker image before deploying an app that can
queue a burn-in** (see "Media worker host" below for the commands). The image
needs the new fonts, the new files under `lib/rough-cut`, and `zod`, which is
now a worker dependency. A stale worker does not merely skip the job it cannot
run: `queueForKind` throws `Unknown job kind BURN_SUBTITLES` inside
`publishPending`, _after_ the batch of up to 20 due jobs has been marked
`QUEUED` and committed. Only the burn-in row is put back to `PENDING`; every
job claimed after it in that batch stays `QUEUED` and is never published, and
nothing recovers a `QUEUED` row. The burn-in row is then re-claimed every two
seconds and strands the tail of the next batch too, so one un-runnable
burn-in quietly stops probes, transcription and proxies behind it.

Then, in the running app:

1. Create a personal **API token** in Settings for NLE panels (`of_live_…`).
2. Project settings: optionally turn on **Show a viewer watermark**, and
   create a **Camera ingest** token (`of_c2c_…`) if field uploaders need one.
3. Upload a still, PDF, or audio file the same way as a video.

Camera ingest from a card or watch folder (not Atomos/RED/ARRI protocol):

```bash
bun run c2c:ingest -- --base-url https://review.example --token of_c2c_… --file clip.mov
bun run c2c:ingest -- --base-url https://review.example --token of_c2c_… --watch ./card
```

`OPENFRAME_BASE_URL` and `C2C_TOKEN` can replace the flags. The watch
command records ingested names in `.c2c-ingested.json` inside that folder.

## NLE panels

See `nle/premiere/README.md` and `nle/resolve/README.md`. After the first
**Sync markers**, deleting a review marker and syncing again resolves that
comment on the web. Free Resolve still uses EDL import from the review page.

## What this deployment will not do

Per-viewer forensic watermarking (NexGuard-class, invisible, unique per
recipient) is not implemented. The CSS overlay plus optional proxy burn-in
are leak deterrents, not forensic marks.
