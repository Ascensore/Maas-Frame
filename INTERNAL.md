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

## Services

`docker compose up --build` starts:

- the Next.js app
- PostgreSQL
- MinIO
- the media worker (ffmpeg + job poller)

The worker probes uploaded files for a rational frame rate and, when
transcription is enabled, extracts audio and transcribes it.
