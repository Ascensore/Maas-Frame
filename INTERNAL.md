# Internal deployment

This fork is for **internal use only**. OpenFrame’s Functional Source License
(FSL-1.1-ALv2) permits internal use and modification. Do not sell this, host it
as a public product, or use the OpenFrame name or marks on anything
public-facing. Give the deployment your own name.

## Upstream rebase

The `upstream` remote points at `https://github.com/yusufipk/OpenFrame.git`.
Rebase this branch onto upstream monthly so custom work stays close to theirs.

```bash
git fetch upstream
git rebase upstream/master
```

Keep custom work **additive**: new files under `app/api/v1/`, `lib/timecode.ts`,
`lib/api-token.ts`, `lib/transcription/`, `worker/`, and `nle/` rebase cleanly.
Avoid editing upstream files except for the Prisma schema, the video-page side
rail (one extra tab), the comment export format switch, and this env template.

`worker/` and `nle/` are independent packages with their own lockfiles. Do not
turn the repo into a Bun workspace: that would make the root `bun.lock` a
workspace lockfile and conflict on every upstream dependency bump.

## Required env for an internal host

Copy `.env.docker.example` to `.env.docker` and set real secrets. The values
that matter for this fork:

| Variable                                    | Value                                              | Why                                                                                                        |
| ------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENFRAME_ENABLE_STRIPE`                   | `false`                                            | Billing is wired into authorization. Off, every account has access and no trial caps apply.                |
| `OPENFRAME_MAX_VIDEO_UPLOAD_BYTES`          | set explicitly (default 100 GiB in the example)    | With Stripe off there is no quota, so the code falls back to a flat **5 GiB** per file unless this is set. |
| `OPENFRAME_ENABLE_S3_VIDEO_UPLOADS`         | `true`                                             | Direct uploads to bundled MinIO.                                                                           |
| `OPENFRAME_ENABLE_BUNNY_UPLOADS`            | `false`                                            | Only one direct-upload backend can be active.                                                              |
| `OPENFRAME_REQUIRE_INVITE_CODE`             | `true`                                             | Registration stays closed. Set `INVITE_CODE`.                                                              |
| `OPENFRAME_ENABLE_ANALYTICS`                | `false`                                            | Leave the marketing funnel off.                                                                            |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | your Workspace OAuth app                           | SSO for the company domain. Restrict the OAuth client to your domain in Google Cloud.                      |
| `OPENFRAME_ENABLE_TRANSCRIPTION`            | `true`                                             | Enqueue transcription after a version lands.                                                               |
| `OPENFRAME_TRANSCRIPTION_PROVIDER`          | `whisper-local` (default), `deepgram`, or `openai` | Pluggable. Cloud providers need their API keys.                                                            |
| `OPENFRAME_ENABLE_PROXY_TRANSCODE`          | `true`                                             | After probe, transcode ProRes/DNx/HEVC/etc. to an H.264 AAC MP4 the browser can play.                      |

On Vercel, `DATABASE_URL` must use the Supabase **session pooler** (IPv4), not
the direct `db.<ref>.supabase.co` host. That host is IPv6-only, so serverless
functions cannot reach it (`P1001`). Session pooler is
`postgres.<ref>@aws-1-eu-west-1.pooler.supabase.com:5432` with
`sslmode=no-verify`. Transaction mode (`:6543`) breaks `LISTEN`/`NOTIFY` used
by live comments.

The session pooler admits only `pool_size` clients at once (15 on the current
compute). Each Vercel isolate therefore opens **one** pooled connection and
drops it after 5 idle seconds (`lib/db-pool.ts`). A pool of 20 per isolate
exceeds that cap immediately (`EMAXCONNSESSION`) and takes down the dashboard
and video player together.

## Services

`docker compose up --build` starts:

- the Next.js app
- PostgreSQL
- MinIO
- the media worker (ffmpeg + job poller)

The worker probes uploaded files for a rational frame rate, transcodes a
review proxy when the master will not play in a browser (and burns a
`CONFIDENTIAL · {project}` label into **new** proxies when the project
watermark is on), and, when transcription is enabled, extracts audio and
transcribes it.

## After pulling this branch

Apply the review-kind / metadata / watermark / camera-ingest schema to the
**app** database (the test database is separate):

```bash
bun run db:migrate
```

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

## What this fork will not do

Per-viewer forensic watermarking (NexGuard-class, invisible, unique per
recipient) is not implemented. The CSS overlay plus optional proxy burn-in
are leak deterrents, not forensic marks.
