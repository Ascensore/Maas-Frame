# Transcript-First Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the rough-cut pipeline transcript-first (no cut without a transcript, no repeated takes), let the operator hand in the original script as the editing guide, carry an exact transcript and caption track onto every rendered cut, let reviewers fix transcript words, burn styled subtitles into a new version, and review/revert cuts against the uncut source.

**Architecture:** The assembler already reads per-version transcripts; this plan makes that mandatory when transcription is on, adds a script-alignment layer to take selection, and derives the output transcript from the decision list instead of re-transcribing. Reviewer decisions live as keyed overrides on the `RoughCut` row and are applied by a pure `applyOverrides` before materialization, which now versions the output video. Subtitle burn-in is a new media job that renders an ASS track with libass into a new version of the same video.

**Tech Stack:** Next.js 16 App Router, Prisma 7 + Postgres, bun, Vitest 4 (unit / api / component projects), the media worker (bun + pg-boss + ffmpeg), zod 4.

---

## Working environment (read before any task)

- **Repository / worktree:** all work happens in `/Users/tommaso/Ascensore - Apps/Maas-Frame-worktrees/transcript-first-editing` on branch `feat/transcript-first-editing` (based on `origin/master` of `Ascensore/Maas-Frame`). Never touch `/Users/tommaso/Ascensore - Apps/Open Frame` (the main checkout) and never `cd` into the Maas People repository.
- **Package manager:** `bun` only. Dependencies are installed (`node_modules` present, Prisma client generated).
- **Project rules:** `AGENTS.md` in the worktree is binding. In particular: tests live under `tests/`, import vitest globals explicitly, never write a BigInt literal, `params` stays `Promise<...>` in route handlers, use `apiErrors`/`successResponse`, use `checkProjectAccess`.
- **Commands:**
  - Unit/component tests, one file: `bun run vitest run --project unit tests/unit/lib/<file>.test.ts` (component: `--project component`).
  - All unit + component: `bun run test`.
  - API tests need the local test Postgres, which is already running in Docker on port 55432. Always prefix the URL: `DATABASE_URL="postgresql://openframe:openframe@127.0.0.1:55432/openframe_test?schema=public" bun run vitest run --project api tests/api/<file>.test.ts`. The api project's global setup runs `prisma db push` against it.
  - Lint + format + typecheck: `bun run check`. Format touched files first with `bunx prettier --write <files>`.
  - After editing `prisma/schema.prisma`: `bun run db:generate`.
- **Commit style:** conventional commits (`feat(rough-cut): …`, `fix: …`, `test: …`), one commit per task at least. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Worker code** (`worker/src`) is not covered by `bun run check` (excluded from tsconfig). Anything with logic goes into `lib/rough-cut/` so it is type-checked and unit tested; the worker only re-exports it. The worker Docker image copies `lib/rough-cut`, `lib/timecode.ts`, `lib/folders.ts`, `lib/export-file-names.ts`, `lib/media-job-queue.ts`; a new shared file outside those must be added to `worker/Dockerfile`. Worker modules import shared code with relative paths (`../lib/rough-cut/...`), never `@/`.
- There is no ffmpeg on this machine: worker jobs are verified through unit tests of their pure parts and through a fake pool/run harness, never by running ffmpeg.

## File map

| Path                                                                                                                                                                                     | Responsibility                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`, `prisma/migrations/20260907100000_transcript_first_editing/migration.sql`                                                                                        | `BURN_SUBTITLES` job kind; `RoughCut.script`, `overrides`, `renderedOverrides`, `renderedDecisions` |
| `lib/rough-cut/env.ts`                                                                                                                                                                   | `isTranscriptionEnvEnabled` (worker-safe flag read)                                                 |
| `lib/rough-cut/transcript-source.ts`                                                                                                                                                     | wait limits, `transcriptRequiredError`                                                              |
| `lib/rough-cut/assemble-job.ts`                                                                                                                                                          | transcript-required policy, auto-enqueue transcription, script-aware editorial pass                 |
| `lib/transcription/ensure.ts`                                                                                                                                                            | app-side "make sure every clip is being transcribed" before a run                                   |
| `lib/rough-cut/script.ts`                                                                                                                                                                | parse the operator's script, align beats to it, group takes by script line, coverage warnings       |
| `lib/rough-cut/text.ts`, `lib/rough-cut/takes.ts`                                                                                                                                        | containment similarity, `script_match` ranking, external groups                                     |
| `lib/rough-cut/overrides.ts`                                                                                                                                                             | reviewer overrides schema, validation, `applyOverrides`                                             |
| `lib/rough-cut/review.ts`                                                                                                                                                                | app-side review payload (sources, render state, effective program)                                  |
| `lib/rough-cut/vtt.ts`, `lib/rough-cut/caption-track.ts`                                                                                                                                 | WebVTT serializer and caption-track upsert shared by worker jobs                                    |
| `lib/rough-cut/derived-transcript.ts`                                                                                                                                                    | transcript of the rendered program derived from the decision list                                   |
| `lib/rough-cut/materialize-job.ts`                                                                                                                                                       | MATERIALIZE_ROUGH_CUT job (moved from worker): overrides, output versioning, derived transcript     |
| `lib/rough-cut/subtitle-style.ts`, `lib/rough-cut/burn-in-job.ts`                                                                                                                        | burn-in style schema, ASS builder, ffmpeg args, BURN_SUBTITLES job                                  |
| `lib/transcript-edit.ts`, `lib/transcript-caption.ts`                                                                                                                                    | segment retiming; caption track rebuilt from a transcript                                           |
| `app/api/projects/[projectId]/rough-cuts/route.ts`                                                                                                                                       | `script` field, transcript readiness                                                                |
| `app/api/rough-cuts/[roughCutId]/overrides/route.ts`, `.../render/route.ts`, `app/api/videos/[videoId]/rough-cut/route.ts`                                                               | review API                                                                                          |
| `app/api/versions/[versionId]/transcript/segments/[segmentId]/route.ts`, `.../transcript/captions/route.ts`                                                                              | transcript editing, captions from transcript                                                        |
| `app/api/videos/[videoId]/burn-in/route.ts`                                                                                                                                              | burn-in job API                                                                                     |
| `components/rough-cut-dialog.tsx`, `components/video-page/hooks/use-rough-cut.ts`                                                                                                        | script textarea                                                                                     |
| `components/video-page/hooks/use-rough-cut-review.ts`, `components/video-page/rough-cut-review-pane.tsx`, `components/video-page-content.tsx`, `components/video-page/comments-pane.tsx` | cut review pane                                                                                     |
| `components/video-page/transcript-pane.tsx`, `components/video-page/hooks/use-transcript-segment-edit.ts`, `components/video-page/hooks/use-subtitles.ts`                                | transcript editing UI, captions without re-transcribing                                             |
| `components/video-page/burn-in-dialog.tsx`, `components/video-page/hooks/use-burn-in.ts`, `components/video-page/subtitle-controls.tsx`, `components/video-page/player-core.tsx`         | burn-in UI                                                                                          |
| `worker/src/index.ts`, `worker/src/materialize-rough-cut.ts`, `worker/src/burn-in.ts`, `worker/Dockerfile`                                                                               | job wiring, fonts                                                                                   |

---

### Task 1: Transcript-required assembly (schema, env flag, wait policy)

**Files:**

- Modify: `prisma/schema.prisma` (enum `MediaJobKind`, model `RoughCut`)
- Create: `prisma/migrations/20260907100000_transcript_first_editing/migration.sql`
- Modify: `tests/setup/db-global.ts` (`REVIEWED_MIGRATIONS`)
- Modify: `lib/rough-cut/env.ts`
- Modify: `lib/rough-cut/transcript-source.ts`
- Modify: `lib/rough-cut/assemble-job.ts`
- Modify: `lib/rough-cut/workspace.ts`
- Test: `tests/unit/lib/rough-cut-transcript-source.test.ts`, `tests/unit/lib/rough-cut-assemble-job.test.ts`, `tests/unit/lib/rough-cut-env.test.ts`, `tests/unit/lib/rough-cut-workspace.test.ts`

Context: today a run that cannot get a transcript within 15 minutes silently falls back to energy-based voice activity, which knows nothing about takes, so every take is kept. The operator's rule is "transcription first". When transcription is enabled on the host (`OPENFRAME_ENABLE_TRANSCRIPTION` is anything but `false`, the same rule as `isTranscriptionFeatureEnabled`), a run must wait for the transcript (up to two hours), must start a transcription itself when a clip has none, and must fail with a clear message instead of degrading when the transcript failed, timed out, or has no speech. The VAD fallback stays only for hosts with transcription disabled.

- [ ] **Step 1: Schema and migration**

In `prisma/schema.prisma`, add `BURN_SUBTITLES` as the last value of `enum MediaJobKind`, and add these fields to `model RoughCut` after `warnings          Json?`:

```prisma
  script            String?         @db.Text
  overrides         Json?
  renderedOverrides Json?           @map("rendered_overrides")
  renderedDecisions Json?           @map("rendered_decisions")
```

Create `prisma/migrations/20260907100000_transcript_first_editing/migration.sql`:

```sql
-- AlterEnum
ALTER TYPE "MediaJobKind" ADD VALUE 'BURN_SUBTITLES';

-- AlterTable
-- script: the copy the speaker read, used to match and rank takes.
-- overrides: the reviewer's restore/keep decisions and extra cuts, keyed by source range.
-- rendered_*: what the last materialization actually rendered, so the review UI can tell
-- saved-but-unrendered changes from rendered ones and map output time to source time.
ALTER TABLE "rough_cuts" ADD COLUMN "script" TEXT,
ADD COLUMN "overrides" JSONB,
ADD COLUMN "rendered_overrides" JSONB,
ADD COLUMN "rendered_decisions" JSONB;
```

Append `'20260907100000_transcript_first_editing',` to `REVIEWED_MIGRATIONS` in `tests/setup/db-global.ts` (plain enum/column additions: no `POST_PUSH_SQL` entry). Run `bun run db:generate`.

- [ ] **Step 2: Failing unit tests for the env flag and the wait policy**

Add to `tests/unit/lib/rough-cut-env.test.ts`:

```ts
import { isTranscriptionEnvEnabled } from '@/lib/rough-cut/env';

describe('isTranscriptionEnvEnabled', () => {
  it('is on unless the flag is literally false', () => {
    expect(isTranscriptionEnvEnabled({})).toBe(true);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: 'true' })).toBe(true);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: 'FALSE' })).toBe(false);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: ' false ' })).toBe(false);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: '0' })).toBe(true);
  });
});
```

Add to `tests/unit/lib/rough-cut-transcript-source.test.ts` (inside `describe('decideTranscriptSource')`, using the file's existing row helpers):

```ts
it('waits past fifteen minutes when a longer limit is given', () => {
  const decision = decideTranscriptSource({
    rows: [row({ id: 't1', versionId: 'v1', status: 'RUNNING' })],
    candidateVersionIds: ['v1'],
    roughCutCreatedAt: new Date(NOW - 20 * 60_000),
    now: new Date(NOW),
    waitLimitSeconds: 2 * 60 * 60,
  });
  expect(decision).toEqual({ kind: 'wait', transcriptId: 't1', versionId: 'v1' });
});
```

and a new describe:

```ts
describe('transcriptRequiredError', () => {
  it('tells the operator what to do for each reason', () => {
    expect(transcriptRequiredError('failed', 'Cam A')).toBe(
      'Transcription failed for Cam A; re-run or upload its transcript, then generate the cut again'
    );
    expect(transcriptRequiredError('timed-out', 'Cam A', 7200)).toBe(
      'The transcript for Cam A was still not ready after 2 hours; check the media worker, then generate the cut again'
    );
    expect(transcriptRequiredError('missing', null)).toBe(
      'No transcript exists; transcribe the clip, then generate the cut again'
    );
    expect(transcriptRequiredError('empty', 'Cam A')).toBe(
      'The transcript for Cam A has no spoken words; check the audio or upload a transcript, then generate the cut again'
    );
  });
});
```

Add to `tests/unit/lib/rough-cut-workspace.test.ts` (create it if absent):

```ts
import { describe, expect, it } from 'vitest';
import { isWaitingForTranscript } from '@/lib/rough-cut/workspace';

describe('isWaitingForTranscript', () => {
  it('reports a PENDING or RUNNING run that carries the waiting warning', () => {
    const warnings = [{ code: 'waiting-for-transcript' }];
    expect(isWaitingForTranscript('PENDING', warnings)).toBe(true);
    expect(isWaitingForTranscript('RUNNING', warnings)).toBe(true);
    expect(isWaitingForTranscript('READY', warnings)).toBe(false);
    expect(isWaitingForTranscript('RUNNING', [{ code: 'weak-transcript' }])).toBe(false);
    expect(isWaitingForTranscript('PENDING', null)).toBe(false);
  });
});
```

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-env.test.ts tests/unit/lib/rough-cut-transcript-source.test.ts tests/unit/lib/rough-cut-workspace.test.ts`
Expected: FAIL (missing exports / wrong values).

- [ ] **Step 3: Implement the flag, the wait limit and the error text**

`lib/rough-cut/env.ts`, append:

```ts
/**
 * Mirror of `isTranscriptionFeatureEnabled` in lib/feature-flags.ts for the
 * worker: on unless the flag is literally "false".
 */
export function isTranscriptionEnvEnabled(
  env: NodeJS.Dict<string | undefined> = process.env
): boolean {
  return (env.OPENFRAME_ENABLE_TRANSCRIPTION ?? '').trim().toLowerCase() !== 'false';
}
```

`lib/rough-cut/transcript-source.ts`:

```ts
/** With transcription on, a run waits this long for its transcript before it fails rather than degrades. */
export const TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS = 2 * 60 * 60;
```

Add `waitLimitSeconds?: number` to `decideTranscriptSource`'s options and use `const limit = options.waitLimitSeconds ?? TRANSCRIPT_WAIT_LIMIT_SECONDS; const canWait = ageSeconds < limit;`.

Give `transcriptFallbackWarning` a third parameter `waitLimitSeconds = TRANSCRIPT_WAIT_LIMIT_SECONDS` and use it in the timed-out message instead of the constant.

Add:

```ts
function clipSubject(clipTitle: string | null | undefined): string {
  return clipTitle && clipTitle.trim()
    ? `the transcript for ${clipTitle.trim()}`
    : 'the transcript';
}

/**
 * Why a run that requires a transcript could not get one. This is the run's
 * error, so it says what the operator can do about it.
 */
export function transcriptRequiredError(
  reason: TranscriptFallbackReason,
  clipTitle?: string | null,
  waitLimitSeconds = TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS
): string {
  const label = clipLabel(clipTitle);
  if (reason === 'failed') {
    return `Transcription failed${label}; re-run or upload its transcript, then generate the cut again`;
  }
  if (reason === 'timed-out') {
    const hours = Math.round(waitLimitSeconds / 3600);
    return `${capitalize(clipSubject(clipTitle))} was still not ready after ${hours} ${hours === 1 ? 'hour' : 'hours'}; check the media worker, then generate the cut again`;
  }
  if (reason === 'empty') {
    return `${capitalize(clipSubject(clipTitle))} has no spoken words; check the audio or upload a transcript, then generate the cut again`;
  }
  return `No transcript exists${label}; transcribe the clip, then generate the cut again`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
```

`lib/rough-cut/workspace.ts`: `isWaitingForTranscript` returns false unless `status === 'PENDING' || status === 'RUNNING'`.

Run the three test files again. Expected: PASS.

- [ ] **Step 4: Failing assemble-job tests for the required policy**

In `tests/unit/lib/rough-cut-assemble-job.test.ts`:

1. Extend `harness` options with `script?: string | null` (returned as `script` on the `FROM rough_cuts` row) and make the fake `query` answer `INSERT INTO transcripts` with `{ rows: [{ id: `t-${params[0]}` }] }` so the auto-enqueue path gets an id back.
2. Add a helper `const transcriptInserts = () => queries.filter((entry) => entry.sql.includes('INSERT INTO transcripts'));` to the harness return.
3. The existing fallback tests exercise the transcription-disabled path now. In each of these tests add `vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');` as the first line: `falls back to voice activity once a run has waited past the limit`, `falls back when a READY transcript has no segments`, `decides per clip in a sequential cut and downloads audio only for the fallback`, `keeps the diarization path for multicam when no transcript exists`, `names a failed transcription and uses voice activity for multicam`, `falls back when every transcript segment is blank`, `keeps each clip in full when neither transcript nor voice activity finds speech`, `marks the run FAILED with the error when the fallback cannot get audio`. (`tests/setup/unit.ts` restores env after each test.)
4. Add a new `describe('assembleRoughCut requires the transcript when transcription is on')`:

```ts
describe('assembleRoughCut requires the transcript when transcription is on', () => {
  beforeEach(() => {
    vi.stubEnv('OPENFRAME_ENABLE_DIARIZATION', 'false');
  });

  it('fails the run instead of falling back when transcription failed', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'FAILED', created_at: NOW_DATE() }],
      vad: { 'ver-a': [{ start: 1, end: 5 }] },
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(
      /Transcription failed for Cam A/
    );

    expect(h.failed()?.params[1]).toBe(
      'Transcription failed for Cam A; re-run or upload its transcript, then generate the cut again'
    );
    expect(h.persisted()).toBeNull();
    expect(h.vadRuns()).toHaveLength(0);
    expect(h.downloads).toHaveLength(0);
  });

  it('starts a transcription and parks the run when a clip has none', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [],
    });

    await assembleRoughCut(h.deps, 'cut-1');

    expect(h.transcriptInserts()).toHaveLength(1);
    expect(h.transcriptInserts()[0]!.params[0]).toBe('ver-a');
    const kinds = h.mediaJobInserts().map((entry) => /'(\w+)'/.exec(entry.sql)?.[1]);
    expect(kinds).toEqual(['EXTRACT_AUDIO', 'TRANSCRIBE', 'ASSEMBLE_ROUGH_CUT']);
    const transcribe = h.mediaJobInserts()[1]!;
    expect(JSON.parse(transcribe.params[1] as string)).toEqual({
      language: 'und',
      transcriptId: 't-ver-a',
    });
    expect(h.persisted()).toBeNull();
    expect(h.failed()).toBeUndefined();
    expect(h.downloads).toHaveLength(0);
  });

  it('keeps waiting for a transcript that is still running after fifteen minutes', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: TWENTY_MINUTES_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'RUNNING', created_at: NOW_DATE() }],
      vad: { 'ver-a': [{ start: 1, end: 5 }] },
    });

    await assembleRoughCut(h.deps, 'cut-1');

    expect(h.mediaJobInserts()).toHaveLength(1);
    expect(h.mediaJobInserts()[0]!.sql).toContain("'ASSEMBLE_ROUGH_CUT'");
    expect(h.vadRuns()).toHaveLength(0);
    expect(h.persisted()).toBeNull();
  });

  it('fails a run that waited two hours for a transcript that never came', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: new Date(NOW - 3 * 60 * 60_000),
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'PENDING', created_at: NOW_DATE() }],
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(/2 hours/);
    expect(h.failed()?.params[1]).toContain('was still not ready after 2 hours');
    expect(h.transcriptInserts()).toHaveLength(0);
  });

  it('fails a run whose only transcript has no spoken words', async () => {
    const h = harness({
      layout: 'LINEAR',
      createdAt: ONE_MINUTE_AGO,
      videos: [video({ version_id: 'ver-a', title: 'Cam A' })],
      transcripts: [{ id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE() }],
      segments: { 't-a': [segment(1, 2, '   ')] },
      vad: { 'ver-a': [{ start: 1, end: 5 }] },
    });

    await expect(assembleRoughCut(h.deps, 'cut-1')).rejects.toThrow(/no spoken words/);
    expect(h.vadRuns()).toHaveLength(0);
  });

  it('enqueues the wide camera’s transcript for a multicam run with none', async () => {
    const h = harness({
      layout: 'MULTICAM',
      createdAt: ONE_MINUTE_AGO,
      videos: [
        video({ version_id: 'ver-wide', title: 'WIDE' }),
        video({ version_id: 'ver-a', title: 'Cam A' }),
      ],
      transcripts: [],
    });

    await assembleRoughCut(h.deps, 'cut-1');

    expect(h.transcriptInserts().map((entry) => entry.params[0])).toEqual(['ver-wide']);
    expect(h.downloads).toHaveLength(0);
  });
});
```

Check how the existing tests express "the run was marked FAILED" (`h.failed()` returns the `status = 'FAILED'` query; its `params[1]` is the error) and that `NOW_DATE` is the helper name the file uses; adapt names to the file, not the other way round.

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-assemble-job.test.ts`
Expected: the new describe fails; the env-stubbed fallback tests pass.

- [ ] **Step 5: Implement the policy in the assemble job**

In `lib/rough-cut/assemble-job.ts`:

1. Imports: `isTranscriptionEnvEnabled` from `./env`; `TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS`, `TRANSCRIPT_WAIT_LIMIT_SECONDS`, `transcriptRequiredError` from `./transcript-source`.
2. `loadRun`'s SELECT adds `script` (used by Task 3; return it now).
3. Add after `deferForTranscript`:

```ts
/**
 * Start a transcription for a clip that has none, the way an upload does:
 * a PENDING transcript row, audio extraction, then the transcribe job. The
 * worker that runs this job is the worker that will transcribe, so the
 * run parks itself and comes back when the row is READY.
 */
async function enqueueTranscription(deps: AssembleDeps, versionId: string): Promise<void> {
  const provider = (process.env.OPENFRAME_TRANSCRIPTION_PROVIDER || 'whisper-local')
    .trim()
    .toLowerCase();
  const upsert = await deps.pool.query(
    `INSERT INTO transcripts (id, version_id, language, provider, status, search_text, error, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, 'und', $2, 'PENDING', '', NULL, NOW(), NOW())
     ON CONFLICT (version_id, language)
     DO UPDATE SET status = 'PENDING', error = NULL, provider = EXCLUDED.provider, updated_at = NOW()
     RETURNING id`,
    [versionId, provider]
  );
  const transcriptId = upsert.rows[0]?.id;
  await deps.pool.query(
    `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
     VALUES (gen_random_uuid()::text, 'EXTRACT_AUDIO', 'PENDING', $1, 0, NOW(), NOW())`,
    [versionId]
  );
  await deps.pool.query(
    `INSERT INTO media_jobs (id, kind, status, version_id, payload, attempts, created_at, updated_at)
     VALUES (gen_random_uuid()::text, 'TRANSCRIBE', 'PENDING', $1, $2::jsonb, 0, NOW(), NOW())`,
    [versionId, JSON.stringify({ language: 'und', transcriptId: transcriptId ?? null })]
  );
}
```

4. In `assembleRoughCut`, replace the block from `const now = new Date();` through the `slots` loop with:

```ts
const required = isTranscriptionEnvEnabled();
const waitLimitSeconds = required
  ? TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS
  : TRANSCRIPT_WAIT_LIMIT_SECONDS;
const now = new Date();
const ageSeconds = (now.getTime() - new Date(cut.created_at).getTime()) / 1000;
const transcriptDecisions = slotCandidates.map((candidateVersionIds) =>
  decideTranscriptSource({
    rows: transcriptRows,
    candidateVersionIds,
    roughCutCreatedAt: cut.created_at,
    now,
    waitLimitSeconds,
  })
);
const titleOf = (versionId: string) =>
  clips.find((clip) => clip.versionId === versionId)?.title ?? '';
const waitingTitles: string[] = [];
for (let index = 0; index < transcriptDecisions.length; index += 1) {
  const decision = transcriptDecisions[index]!;
  if (decision.kind === 'wait') {
    waitingTitles.push(titleOf(decision.versionId));
    continue;
  }
  if (!required || decision.kind !== 'fallback') continue;
  // Transcription is on, so a clip without a transcript gets one now and
  // the run waits; anything else the operator has to look at.
  const first = slotCandidates[index]![0]!;
  if (decision.reason === 'missing' && ageSeconds < waitLimitSeconds) {
    await enqueueTranscription(deps, first);
    waitingTitles.push(titleOf(first));
    continue;
  }
  throw new Error(transcriptRequiredError(decision.reason, titleOf(first), waitLimitSeconds));
}
if (waitingTitles.length > 0) {
  await deferForTranscript(deps, {
    roughCutId,
    versionId: clips[0]!.versionId,
    warnings: [...warnings, waitingForTranscriptWarning(waitingTitles)],
  });
  return;
}
const slots: TranscriptSlot[] = [];
for (let index = 0; index < transcriptDecisions.length; index += 1) {
  const decision = transcriptDecisions[index]!;
  if (decision.kind === 'wait') continue;
  const slot = await resolveTranscriptSlot(deps, decision, transcriptRows);
  if (required && slot.kind === 'fallback') {
    throw new Error(
      transcriptRequiredError(slot.reason, titleOf(slotCandidates[index]![0]!), waitLimitSeconds)
    );
  }
  slots.push(slot);
}
```

5. `materialFor` gains `required: boolean` in its options. When `slot.kind === 'use'` and `analysis.runs.length === 0` and `required`, throw `new Error(transcriptRequiredError('empty', options.label))` instead of falling back. When `slot.kind === 'fallback'` and `required`, throw `new Error(transcriptRequiredError(slot.reason, options.label, waitLimitSeconds))` (pass `waitLimitSeconds` in the options too). Pass `required` and `waitLimitSeconds` from both call sites (`assembleLinearLayout` receives them through its options; the multicam call site has them in scope). `transcriptFallbackWarning` calls get `waitLimitSeconds` as the third argument.
6. The multicam branch that reads `if (slot.kind === 'fallback') warnings.push(transcriptFallbackWarning(slot.reason));` is unreachable when `required` (the loop above threw); leave it for the disabled path.

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-assemble-job.test.ts tests/unit/lib/rough-cut-transcript-source.test.ts`
Expected: PASS.

- [ ] **Step 6: Whole-suite check and commit**

Run: `bun run test` and `bun run check`. Fix formatting with `bunx prettier --write` on touched files.

```bash
git add prisma lib tests
git commit -m "feat(rough-cut): require the transcript before assembling when transcription is on

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The operator's script on the run, and transcription started at run creation

**Files:**

- Create: `lib/transcription/ensure.ts`
- Modify: `app/api/projects/[projectId]/rough-cuts/route.ts`
- Modify: `app/api/rough-cuts/[roughCutId]/route.ts` (GET returns the script)
- Modify: `lib/rough-cut/serialize.ts` (`shapeRoughCut`)
- Modify: `components/video-page/hooks/use-rough-cut.ts` (`start` accepts `script`)
- Modify: `components/rough-cut-dialog.tsx` (script textarea)
- Test: `tests/api/rough-cuts.test.ts`, `tests/component/hooks/use-rough-cut.test.ts`

Context: the assembler (Task 1) parks a run until its transcripts are READY and starts one when a clip has none, but on a Vercel host without a media worker the only thing that transcribes is the app's own inline path (`scheduleVersionTranscription`). So the create route must make sure every file-backed clip has a transcript on the way before it enqueues the run. The route also stores the operator's optional script (max 20 000 characters) that Task 3 reads.

- [ ] **Step 1: Failing API tests**

In `tests/api/rough-cuts.test.ts`, inside `describe('POST /api/projects/[projectId]/rough-cuts')`, add (the file already imports `db`, `createReadyTranscript` is exported from `../factories`, `scheduleVersionTranscription` is mocked by `tests/setup/api.ts` and importable from `@/lib/transcription/schedule`):

```ts
it('starts a transcription for every file-backed clip that has none and parks the run', async () => {
  const scenario = await seedMulticam();
  await createReadyTranscript({
    versionId: scenario.versionA.id,
    segments: [{ startSec: 0, endSec: 2, text: 'hello' }],
  });
  signedInAs(scenario.owner);
  vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

  const response = await callRoute(
    createRoughCutRoute,
    apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
    { projectId: scenario.project.id }
  );

  expect(response.status).toBe(201);
  const payload = await readData<{
    roughCut: { id: string; warnings: Array<{ code: string }> | null };
    transcripts: { ready: number; pending: number; enqueued: number; failed: number };
  }>(response);
  expect(payload.transcripts).toEqual({ ready: 1, pending: 1, enqueued: 1, failed: 0 });
  expect(payload.roughCut.warnings?.map((warning) => warning.code)).toEqual([
    'waiting-for-transcript',
  ]);

  const pending = await db.transcript.findMany({ where: { versionId: scenario.versionB.id } });
  expect(pending.map((row) => row.status)).toEqual(['PENDING']);
  const jobs = await db.mediaJob.findMany({
    where: { versionId: scenario.versionB.id },
    orderBy: { createdAt: 'asc' },
  });
  expect(jobs.map((job) => job.kind)).toEqual(['EXTRACT_AUDIO', 'TRANSCRIBE']);
  expect(
    await db.mediaJob.count({ where: { versionId: scenario.versionA.id, kind: 'TRANSCRIBE' } })
  ).toBe(0);
  expect(vi.mocked(scheduleVersionTranscription)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(scheduleVersionTranscription).mock.calls[0]?.[0]).toBe(scenario.versionB.id);
});

it('retries a FAILED transcript when a cut is requested', async () => {
  const scenario = await seedMulticam();
  for (const version of [scenario.versionA, scenario.versionB]) {
    await createReadyTranscript({
      versionId: version.id,
      status: 'FAILED',
      segments: [],
    });
  }
  signedInAs(scenario.owner);
  vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

  const response = await callRoute(
    createRoughCutRoute,
    apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
    { projectId: scenario.project.id }
  );

  expect(response.status).toBe(201);
  const rows = await db.transcript.findMany({
    where: { versionId: { in: [scenario.versionA.id, scenario.versionB.id] } },
  });
  expect(rows.map((row) => row.status)).toEqual(['PENDING', 'PENDING']);
});

it('stores a trimmed script and refuses one that is too long', async () => {
  const scenario = await seedMulticam();
  signedInAs(scenario.owner);
  vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

  const refused = await callRoute(
    createRoughCutRoute,
    apiRequest(cutsUrl(scenario.project.id), {
      body: { folderId: null, script: 'x'.repeat(20_001) },
    }),
    { projectId: scenario.project.id }
  );
  expect(refused.status).toBe(400);
  expect(await db.roughCut.count()).toBe(0);

  const response = await callRoute(
    createRoughCutRoute,
    apiRequest(cutsUrl(scenario.project.id), {
      body: { folderId: null, script: '  We help founders raise faster.\n\n  ' },
    }),
    { projectId: scenario.project.id }
  );
  expect(response.status).toBe(201);
  const payload = await readData<{ roughCut: { id: string; hasScript: boolean } }>(response);
  expect(payload.roughCut.hasScript).toBe(true);
  const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
  expect(stored.script).toBe('We help founders raise faster.');

  const detail = await callRoute(
    getRoughCutRoute,
    apiRequest(`/api/rough-cuts/${payload.roughCut.id}`),
    { roughCutId: payload.roughCut.id }
  );
  const shown = await readData<{ roughCut: { script: string | null } }>(detail);
  expect(shown.roughCut.script).toBe('We help founders raise faster.');
});
```

Existing POST tests that count `mediaJob` rows or assert the run's `warnings` will now see EXTRACT_AUDIO/TRANSCRIBE rows and a waiting warning (the seeded r2 versions have no transcript). Adjust those assertions to filter by `kind: 'ASSEMBLE_ROUGH_CUT'`, or seed a READY transcript with `createReadyTranscript` where a test wants the pre-existing behaviour; do not weaken the assertion.

Run: `DATABASE_URL="postgresql://openframe:openframe@127.0.0.1:55432/openframe_test?schema=public" bun run vitest run --project api tests/api/rough-cuts.test.ts`
Expected: the three new tests FAIL.

- [ ] **Step 2: Implement `ensureTranscriptsForVersions`**

Create `lib/transcription/ensure.ts`:

```ts
import { MediaJobKind, Prisma, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { getTranscriptionProviderName, isTranscriptionFeatureEnabled } from '@/lib/feature-flags';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { canAutoTranscribe, type ReviewKind } from '@/lib/review-kind';
import { AUTO_DETECT_TRANSCRIPT_LANGUAGE } from '@/lib/transcription/language';
import { scheduleVersionTranscription } from '@/lib/transcription/schedule';

export type TranscriptReadiness = {
  /** Versions with a READY transcript. */
  ready: string[];
  /** Versions whose transcript is PENDING or RUNNING, including the ones started here. */
  pending: string[];
  /** Versions this call started a transcription for. */
  enqueued: string[];
  /** Versions that cannot be transcribed on this host. */
  failed: string[];
};

/**
 * Before a cut is assembled, every clip needs a transcript on the way. READY
 * and in-progress rows are left alone. A version with no row, or whose rows
 * all FAILED, gets a fresh PENDING row plus the extract and transcribe jobs,
 * exactly as an upload does, and the inline runner is scheduled for hosts
 * without a media worker. Auto-detect is the language, as on upload.
 */
export async function ensureTranscriptsForVersions(
  versions: Array<{ id: string; providerId: string; kind: ReviewKind }>
): Promise<TranscriptReadiness> {
  const readiness: TranscriptReadiness = { ready: [], pending: [], enqueued: [], failed: [] };
  if (versions.length === 0) return readiness;

  const rows = await db.transcript.findMany({
    where: { versionId: { in: versions.map((version) => version.id) } },
    select: { versionId: true, status: true },
  });
  const byVersion = new Map<string, TranscriptStatus[]>();
  for (const row of rows) {
    const list = byVersion.get(row.versionId) ?? [];
    list.push(row.status);
    byVersion.set(row.versionId, list);
  }

  for (const version of versions) {
    const statuses = byVersion.get(version.id) ?? [];
    if (statuses.includes(TranscriptStatus.READY)) {
      readiness.ready.push(version.id);
      continue;
    }
    if (
      statuses.includes(TranscriptStatus.PENDING) ||
      statuses.includes(TranscriptStatus.RUNNING)
    ) {
      readiness.pending.push(version.id);
      continue;
    }
    if (!isTranscriptionFeatureEnabled() || !canAutoTranscribe(version.kind, version.providerId)) {
      readiness.failed.push(version.id);
      continue;
    }

    const language = AUTO_DETECT_TRANSCRIPT_LANGUAGE;
    const transcript = await db.transcript.upsert({
      where: { versionId_language: { versionId: version.id, language } },
      create: {
        versionId: version.id,
        language,
        provider: getTranscriptionProviderName(),
        status: TranscriptStatus.PENDING,
      },
      update: {
        status: TranscriptStatus.PENDING,
        error: null,
        provider: getTranscriptionProviderName(),
        translationLanguage: null,
        translationStatus: null,
        translationError: null,
        translatedTexts: Prisma.DbNull,
      },
    });
    await enqueueMediaJob(version.id, MediaJobKind.EXTRACT_AUDIO);
    await enqueueMediaJob(version.id, MediaJobKind.TRANSCRIBE, {
      language,
      transcriptId: transcript.id,
    });
    scheduleVersionTranscription(version.id, language, transcript.id);
    readiness.enqueued.push(version.id);
    readiness.pending.push(version.id);
  }

  return readiness;
}
```

Note: a version whose rows all FAILED still has a row for language `und` (or another language). The upsert keys on `(versionId, 'und')`; a FAILED row in a different language stays FAILED, which is fine because the assembler picks READY rows first.

- [ ] **Step 3: The create route stores the script and calls `ensureTranscriptsForVersions`**

In `app/api/projects/[projectId]/rough-cuts/route.ts`:

1. Imports: `ensureTranscriptsForVersions` from `@/lib/transcription/ensure`; `waitingForTranscriptWarning` from `@/lib/rough-cut/transcript-source`; `SCRIPT_MAX_CHARS` from `@/lib/rough-cut/script` (Task 3 creates the module; for now add `export const SCRIPT_MAX_CHARS = 20_000;` to a new `lib/rough-cut/script.ts` containing only that constant).
2. After the `briefId` parsing block, add:

```ts
let script: string | null = null;
if (body && body.script !== undefined && body.script !== null) {
  if (typeof body.script !== 'string') {
    return apiErrors.badRequest('script must be a string');
  }
  const trimmed = body.script.trim();
  if (trimmed.length > SCRIPT_MAX_CHARS) {
    return apiErrors.badRequest(`script must be ${SCRIPT_MAX_CHARS} characters or fewer`);
  }
  script = trimmed || null;
}
```

3. After the `existing` (409) check and before `db.roughCut.create`, add:

```ts
// Transcription first: every clip must have a transcript on the way
// before the run is queued. The assembler parks the run until they are
// READY (lib/rough-cut/assemble-job.ts).
const readiness = await ensureTranscriptsForVersions(
  fileBacked.map((video) => ({
    id: video.versions[0]!.id,
    providerId: video.versions[0]!.providerId,
    kind: 'VIDEO' as const,
  }))
);
const pendingTitles = fileBacked
  .filter((video) => readiness.pending.includes(video.versions[0]!.id))
  .map((video) => video.title);
```

4. In the `create` data add `script,` and `warnings: pendingTitles.length > 0 ? ([waitingForTranscriptWarning(pendingTitles)] as Prisma.InputJsonValue) : undefined,`.
5. In the response add `transcripts: { ready: readiness.ready.length, pending: readiness.pending.length, enqueued: readiness.enqueued.length, failed: readiness.failed.length },`.

`lib/rough-cut/serialize.ts`: `shapeRoughCut(row, options: { includeScript?: boolean } = {})`; the row type gains `script?: string | null`, `overrides?: Prisma.JsonValue | null`, `renderedOverrides?: Prisma.JsonValue | null`; the shape gains `hasScript: Boolean(row.script)`, `script: options.includeScript ? (row.script ?? null) : undefined`, `hasOverrides: row.overrides != null`. The single-run GET in `app/api/rough-cuts/[roughCutId]/route.ts` calls `shapeRoughCut(loaded.row, { includeScript: true })`.

Run the api file again. Expected: PASS (fix any test that counted media jobs, as described in Step 1).

- [ ] **Step 4: Dialog and hook**

`components/video-page/hooks/use-rough-cut.ts`: add `script?: string` to `start`'s options and `...(options.script ? { script: options.script } : {})` to the POST body. In `tests/component/hooks/use-rough-cut.test.ts`, add a test that `start({ ..., script: 'Hello there.' })` sends `script` in the body and that omitting it sends no `script` key (read the file's fetch-mock conventions first).

`components/rough-cut-dialog.tsx`: import `Textarea` from `@/components/ui/textarea` and `SCRIPT_MAX_CHARS` from `@/lib/rough-cut/script`. Add `const [script, setScript] = useState('');`, reset it in the `onOpenChange` cleanup, pass `script: script.trim() || undefined` to `start(...)`, and render this block right after the "Editorial brief" select block (before `profilesError`):

```tsx
<div className="space-y-2">
  <label htmlFor="rough-cut-script" className="text-sm font-medium">
    Original script (optional)
  </label>
  <Textarea
    id="rough-cut-script"
    value={script}
    onChange={(event) => setScript(event.target.value)}
    maxLength={SCRIPT_MAX_CHARS}
    rows={5}
    placeholder="Paste the copy the speaker read, one line or sentence per beat."
    disabled={busy || !!status}
  />
  <p className="text-xs text-muted-foreground">
    Takes are matched against the script: the take closest to each line is kept, and lines with no
    clean take are flagged after assembly.
  </p>
</div>
```

Also change the dialog's waiting copy: the `status === 'PENDING'` branch shows `'Waiting for the transcript…'` when `isWaitingForTranscript(status, roughCut?.warnings)` (it already handles RUNNING); simplest is to compute `const waitingForTranscript = isWaitingForTranscript(status ?? '', roughCut?.warnings);` and render `waitingForTranscript ? 'Waiting for the transcript…' : status === 'PENDING' ? 'Queued…' : 'Assembling the rough cut…'`.

Presentation only, no component test for the textarea.

- [ ] **Step 5: Verify and commit**

Run: `bun run test`, the api file with the DATABASE_URL prefix, `bun run check`.

```bash
git add lib app components tests
git commit -m "feat(rough-cut): accept the operator's script and start transcription when a cut is requested

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Script-aware take selection and contained retakes

**Files:**

- Modify: `lib/rough-cut/text.ts` (`containment`)
- Modify: `lib/rough-cut/takes.ts` (containment grouping, `alsoGroup`, `script_match` ranking)
- Create: `lib/rough-cut/script.ts` (replace the constant-only stub from Task 2)
- Modify: `lib/rough-cut/assemble-job.ts` (`editorialPass` reads the script)
- Test: `tests/unit/lib/rough-cut-script.test.ts`, `tests/unit/lib/rough-cut-takes.test.ts`, `tests/unit/lib/rough-cut-assemble-job.test.ts`

Context: takes are grouped by Jaccard similarity of word trigrams (≥ 0.5). A retake that only re-says the second half of a line, or a line that the transcript split into two beats, shares too few trigrams with the whole and stays in the cut: that is the "same take twice" the operator saw. Two fixes: (1) containment, the share of the smaller take's trigrams found in the larger one, groups partial retakes; (2) when the operator gave a script, beats are aligned to script lines, beats covering the same line are takes of that line whatever their wording, and the take that matches the script best wins before cleanliness.

- [ ] **Step 1: Failing tests for text and takes**

Add to `tests/unit/lib/rough-cut-takes.test.ts` (reuse the file's `candidate`, `EN` and `MEDIUM` helpers; import `containment` from `@/lib/rough-cut/text` and `rankingWithScript` from `@/lib/rough-cut/script`):

```ts
it('measures containment from the smaller set', () => {
  expect(containment(new Set(['a', 'b', 'c', 'd']), new Set(['c', 'd']))).toBe(1);
  expect(containment(new Set(['c', 'x']), new Set(['a', 'b', 'c', 'd']))).toBe(0.5);
  expect(containment(new Set(), new Set(['a']))).toBe(0);
});

it('groups a retake that only repeats the tail of a longer take', () => {
  const first = candidate(
    0,
    'in this video we look at how founders raise their seed round faster than before'
  );
  const tail = candidate(20, 'how founders raise their seed round faster than before');
  expect(
    jaccard(
      trigrams(
        contentTokens(
          first.beat.words.map((w) => w.text),
          EN
        )
      ),
      trigrams(
        contentTokens(
          tail.beat.words.map((w) => w.text),
          EN
        )
      )
    )
  ).toBeLessThan(0.5);
  expect(groupTakes([first, tail], { fillers: EN })).toEqual([[0, 1]]);
});

it('does not treat a short repeated phrase as a contained take', () => {
  const long = candidate(0, 'thank you so much for being here with us today everyone');
  const short = candidate(30, 'thank you so much for being');
  expect(groupTakes([long, short], { fillers: EN })).toEqual([]);
});

it('unions externally supplied groups into the take groups', () => {
  const a = candidate(0, 'our product does the heavy lifting for you');
  const b = candidate(15, 'the platform handles all of the boring parts');
  expect(groupTakes([a, b], { fillers: EN })).toEqual([]);
  expect(groupTakes([a, b], { fillers: EN, alsoGroup: [[0, 1]] })).toEqual([[0, 1]]);
});

it('ranks by script match first when asked, then falls through to cleanliness', () => {
  const offScript = { ...candidate(0, 'we help founders raise faster'), scriptMatch: 0.4 };
  const onScript = { ...candidate(10, 'we help um founders raise faster'), scriptMatch: 1 };
  const decisions = selectTakes([offScript, onScript], {
    fillers: EN,
    ranking: rankingWithScript(['cleanliness', 'energy']),
    longPauseSeconds: MEDIUM.maxKeptGapInsideBeatSeconds,
  });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.keptIndex).toBe(1);
  expect(decisions[0]!.scores.get(1)?.scriptMatch).toBe(1);
});
```

Create `tests/unit/lib/rough-cut-script.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { analyseSpeech, type Beat } from '@/lib/rough-cut/beats';
import { SILENCE_AGGRESSIVENESS } from '@/lib/rough-cut/brief';
import {
  alignBeatToScript,
  parseScript,
  rankingWithScript,
  scriptCoverageWarnings,
  scriptTakeGroups,
  splitScriptLines,
} from '@/lib/rough-cut/script';
import { fillerWordsFor } from '@/lib/rough-cut/text';

const EN = fillerWordsFor('en');

function beatAt(at: number, text: string): Beat {
  const words = text.split(' ').map((word, index) => ({
    start: at + index * 0.4,
    end: at + index * 0.4 + 0.3,
    text: word,
  }));
  return analyseSpeech(
    [
      {
        startSec: words[0]!.start,
        endSec: words[words.length - 1]!.end,
        speaker: null,
        text,
        words,
      },
    ],
    { versionId: 'v', durationSeconds: 100_000, policy: SILENCE_AGGRESSIVENESS.low }
  ).beats[0]!;
}

const SCRIPT =
  'We help founders raise faster.\nOur product does the heavy lifting. Thanks for watching, see you next time!\n\nOK';

describe('splitScriptLines / parseScript', () => {
  it('splits on newlines and sentence ends and drops lines under three words', () => {
    expect(splitScriptLines(SCRIPT)).toEqual([
      'We help founders raise faster.',
      'Our product does the heavy lifting.',
      'Thanks for watching, see you next time!',
      'OK',
    ]);
    const lines = parseScript(SCRIPT, EN);
    expect(lines.map((line) => line.index)).toEqual([0, 1, 2]);
    expect(lines[0]!.tokens).toEqual(['we', 'help', 'founders', 'raise', 'faster']);
  });
});

describe('alignBeatToScript', () => {
  const lines = parseScript(SCRIPT, EN);

  it('covers the line a beat reads and scores how much of the beat is on script', () => {
    expect(alignBeatToScript(beatAt(0, 'we help founders raise faster'), lines, EN)).toEqual({
      lines: [0],
      score: 1,
    });
  });

  it('scores a paraphrase below a verbatim read and covers nothing when too different', () => {
    const paraphrase = alignBeatToScript(
      beatAt(0, 'we help founders raise much faster'),
      lines,
      EN
    );
    expect(paraphrase.lines).toEqual([0]);
    expect(paraphrase.score).toBeCloseTo(0.5);
    expect(alignBeatToScript(beatAt(0, 'completely unrelated words here'), lines, EN)).toEqual({
      lines: [],
      score: 0,
    });
  });

  it('can cover two lines read back to back', () => {
    const both = alignBeatToScript(
      beatAt(0, 'we help founders raise faster our product does the heavy lifting'),
      lines,
      EN
    );
    expect(both.lines).toEqual([0, 1]);
  });
});

describe('scriptTakeGroups', () => {
  it('groups beats that cover the same line inside the window and splits beyond it', () => {
    const candidates = [{ timelineStart: 0 }, { timelineStart: 30 }, { timelineStart: 2000 }];
    const alignments = [
      { lines: [0], score: 1 },
      { lines: [0], score: 0.7 },
      { lines: [0], score: 1 },
    ];
    expect(scriptTakeGroups(candidates, alignments, 600)).toEqual([[0, 1]]);
    expect(
      scriptTakeGroups(candidates, [alignments[0]!, { lines: [1], score: 1 }, alignments[2]!], 600)
    ).toEqual([]);
  });
});

describe('scriptCoverageWarnings / rankingWithScript', () => {
  it('names unspoken lines and counts off-script beats', () => {
    const lines = parseScript(SCRIPT, EN);
    const warnings = scriptCoverageWarnings(lines, [
      { lines: [0], score: 1 },
      { lines: [], score: 0.1 },
    ]);
    expect(warnings.map((warning) => warning.code)).toEqual([
      'script-lines-missing',
      'off-script-beats',
    ]);
    expect(warnings[0]!.message).toContain('2 of 3 script lines');
    expect(warnings[0]!.message).toContain('Our product does the heavy lifting.');
    expect(scriptCoverageWarnings(lines, [{ lines: [0, 1, 2], score: 1 }])).toEqual([]);
  });

  it('puts script match first and keeps the rest in order', () => {
    expect(rankingWithScript(['cleanliness', 'energy'])).toEqual([
      'script_match',
      'cleanliness',
      'energy',
    ]);
    expect(rankingWithScript(['energy', 'script_match'])).toEqual(['script_match', 'energy']);
  });
});
```

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-takes.test.ts tests/unit/lib/rough-cut-script.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement `containment`, take options and the script module**

`lib/rough-cut/text.ts`, after `jaccard`:

```ts
/**
 * Share of the smaller set found in the larger one. 1 when one take is a
 * piece of the other, which Jaccard punishes because the larger take's
 * extra shingles count against it.
 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const entry of smaller) if (larger.has(entry)) shared += 1;
  return shared / smaller.size;
}
```

`lib/rough-cut/takes.ts`:

```ts
/** Share of the shorter take's trigrams that the longer one contains before they count as the same take. */
export const TAKE_CONTAINMENT_THRESHOLD = 0.6;
/** A contained retake needs this many content tokens; shorter phrases repeat for other reasons. */
export const TAKE_CONTAINMENT_MIN_TOKENS = 6;
```

- `TakeCandidate` gains `scriptMatch?: number | null;` (`/** How well the beat matches the operator's script, 0–1, when there is one. */`).
- `TakeScores` gains `scriptMatch: number | null;`.
- `groupTakes` options gain `alsoGroup?: number[][]` (`/** Index groups a second signal found, unioned in as if their members matched. */`). Keep the token counts: `const tokenCounts = candidates.map(...)` alongside `shingles`; a pair matches when `jaccard(left, right) >= similarity` or `Math.min(tokenCounts[a]!, tokenCounts[b]!) >= TAKE_CONTAINMENT_MIN_TOKENS && containment(left, right) >= TAKE_CONTAINMENT_THRESHOLD`. After the pairwise loop: `for (const group of options.alsoGroup ?? []) for (let i = 1; i < group.length; i += 1) parent[find(parent, group[0]!)] = find(parent, group[i]!);` (guard indices with `candidates[index]` existence).
- `compareBy`: `if (criterion === 'script_match') { const l = left.scriptMatch ?? -1; const r = right.scriptMatch ?? -1; if (l !== r) return r - l; }`.
- `selectTakes` options gain `alsoGroup?: number[][]` (forwarded) and scores include `scriptMatch: candidate.scriptMatch ?? null`.

Replace the stub `lib/rough-cut/script.ts` with:

```ts
import type { Beat } from './beats';
import type { BriefRankingCriterion } from './brief';
import { contentTokens, excerpt, tokenize, trigrams } from './text';
import type { RoughCutWarning } from './types';

/**
 * The operator's script as an editorial guide. Lines are the units a take is
 * matched against; a beat that reads a line is a take of that line, and the
 * take that reads it most faithfully wins. Pure, so the worker can import it.
 */

export const SCRIPT_MAX_CHARS = 20_000;
/** A script line counts as covered by a beat when this share of its trigrams occurs in the beat. */
export const SCRIPT_LINE_COVERAGE = 0.5;
/** Below this share of on-script trigrams a kept beat is reported as off-script. */
export const SCRIPT_OFF_SCRIPT_THRESHOLD = 0.2;
export const SCRIPT_LINE_MIN_TOKENS = 3;

export type ScriptLine = { index: number; text: string; tokens: string[]; shingles: Set<string> };

/** Lines and sentences of the script, in order, blank lines dropped. */
export function splitScriptLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n+|(?<=[.!?…]["'»”)\]]*)\s+(?=\S)/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseScript(text: string, fillers: ReadonlySet<string>): ScriptLine[] {
  const lines: ScriptLine[] = [];
  for (const raw of splitScriptLines(text)) {
    const tokens = contentTokens(tokenize(raw), fillers);
    if (tokens.length < SCRIPT_LINE_MIN_TOKENS) continue;
    lines.push({ index: lines.length, text: raw, tokens, shingles: trigrams(tokens) });
  }
  return lines;
}

export type ScriptAlignment = {
  /** Script lines this beat covers, in script order. */
  lines: number[];
  /** Share of the beat's trigrams found anywhere in the script: 1 is fully on script. */
  score: number;
};

export function alignBeatToScript(
  beat: Beat,
  lines: ScriptLine[],
  fillers: ReadonlySet<string>
): ScriptAlignment {
  const shingles = trigrams(
    contentTokens(
      beat.words.map((word) => word.text),
      fillers
    )
  );
  if (shingles.size === 0 || lines.length === 0) return { lines: [], score: 0 };
  const covered: number[] = [];
  const onScript = new Set<string>();
  for (const line of lines) {
    let shared = 0;
    for (const shingle of line.shingles) {
      if (!shingles.has(shingle)) continue;
      shared += 1;
      onScript.add(shingle);
    }
    if (line.shingles.size > 0 && shared / line.shingles.size >= SCRIPT_LINE_COVERAGE) {
      covered.push(line.index);
    }
  }
  return { lines: covered, score: onScript.size / shingles.size };
}

/**
 * Beats that cover the same script line within the window are takes of that
 * line, whatever their wording. Members further apart than the window are
 * different readings of a repeated line, not retakes.
 */
export function scriptTakeGroups(
  candidates: ReadonlyArray<{ timelineStart: number }>,
  alignments: ScriptAlignment[],
  windowSeconds: number
): number[][] {
  const byLine = new Map<number, number[]>();
  alignments.forEach((alignment, index) => {
    for (const line of alignment.lines) {
      const list = byLine.get(line) ?? [];
      list.push(index);
      byLine.set(line, list);
    }
  });
  const groups: number[][] = [];
  for (const members of byLine.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(
      (a, b) => candidates[a]!.timelineStart - candidates[b]!.timelineStart
    );
    let current: number[] = [sorted[0]!];
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const next = sorted[index]!;
      if (candidates[next]!.timelineStart - candidates[previous]!.timelineStart > windowSeconds) {
        if (current.length > 1) groups.push(current);
        current = [next];
      } else {
        current.push(next);
      }
    }
    if (current.length > 1) groups.push(current);
  }
  return groups.sort((a, b) => candidates[a[0]!]!.timelineStart - candidates[b[0]!]!.timelineStart);
}

/** After take selection: lines nobody read cleanly, and kept beats the script does not contain. */
export function scriptCoverageWarnings(
  lines: ScriptLine[],
  kept: ScriptAlignment[]
): RoughCutWarning[] {
  const warnings: RoughCutWarning[] = [];
  const covered = new Set(kept.flatMap((alignment) => alignment.lines));
  const missing = lines.filter((line) => !covered.has(line.index));
  if (missing.length > 0) {
    const sample = missing
      .slice(0, 3)
      .map((line) => `“${excerpt(line.text, 60)}”`)
      .join(', ');
    warnings.push({
      code: 'script-lines-missing',
      message: `${missing.length} of ${lines.length} script lines have no matching take in the cut: ${sample}`,
    });
  }
  const offScript = kept.filter(
    (alignment) => alignment.score < SCRIPT_OFF_SCRIPT_THRESHOLD
  ).length;
  if (offScript > 0) {
    warnings.push({
      code: 'off-script-beats',
      message:
        offScript === 1
          ? '1 kept beat is not in the script; review whether it belongs in the cut'
          : `${offScript} kept beats are not in the script; review whether they belong in the cut`,
    });
  }
  return warnings;
}

/** With a script, the take that matches it wins before anything else the brief ranks by. */
export function rankingWithScript(ranking: BriefRankingCriterion[]): BriefRankingCriterion[] {
  return ['script_match', ...ranking.filter((criterion) => criterion !== 'script_match')];
}
```

`tokenize` exists in text.ts; `contentTokens` normalises again, which is idempotent.

Run the two unit files. Expected: PASS.

- [ ] **Step 3: Failing assemble-job test with a script**

In `tests/unit/lib/rough-cut-assemble-job.test.ts`, inside `describe('assembleRoughCut editorial pass')`, add (use the describe's own timed-words helper, the talking-head brief snapshot the neighbouring take-selection test uses, and the harness `script` option from Task 1):

```ts
it('keeps the take that reads the script and flags the line nobody spoke', async () => {
  const h = harness({
    layout: 'LINEAR',
    createdAt: ONE_MINUTE_AGO,
    briefSnapshot: TALKING_HEAD_SNAPSHOT,
    script:
      'We help founders raise faster.\nOur product does the heavy lifting.\nThanks for watching.',
    videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 60 })],
    transcripts: [
      { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
    ],
    segments: {
      't-a': [
        timed(1, 'we help founders raise faster'),
        timed(10, 'we help founders raise much faster'),
        timed(20, 'thanks for watching'),
      ],
    },
  });

  await assembleRoughCut(h.deps, 'cut-1');

  const result = h.persisted();
  const rejected = result?.decisions?.cuts?.filter((cut) => cut.reason.code === 'REJECTED_TAKE');
  expect(rejected?.map((cut) => [cut.inSeconds, cut.transcriptText])).toEqual([
    [10, 'we help founders raise much faster'],
  ]);
  expect(result?.decisions?.edits.map((edit) => edit.inSeconds)).toEqual([1, 20]);
  expect(result?.warnings.map((warning) => warning.code)).toContain('script-lines-missing');
  expect(
    result?.warnings.find((warning) => warning.code === 'script-lines-missing')?.message
  ).toContain('Our product does the heavy lifting.');
});

it('ignores the script when the brief does not select takes', async () => {
  const h = harness({
    layout: 'LINEAR',
    createdAt: ONE_MINUTE_AGO,
    briefSnapshot: ASCENSORE_SNAPSHOT,
    script: 'We help founders raise faster.',
    videos: [video({ version_id: 'ver-a', title: 'Cam A', duration: 60 })],
    transcripts: [
      { id: 't-a', version_id: 'ver-a', status: 'READY', created_at: NOW_DATE(), language: 'en' },
    ],
    segments: {
      't-a': [
        timed(1, 'we help founders raise faster'),
        timed(10, 'we help founders raise faster'),
      ],
    },
  });

  await assembleRoughCut(h.deps, 'cut-1');

  const result = h.persisted();
  expect(result?.decisions?.edits).toHaveLength(2);
  expect(result?.warnings.map((warning) => warning.code)).toContain('script-ignored');
});
```

Without the script, recency keeps the second take (both are equally clean); with it, take one scores 1.0 and take two 0.5 (two of its four trigrams are off script), so take one is kept. Name the snapshot/timed helpers as the file does (`TALKING_HEAD_SNAPSHOT`, `ASCENSORE_SNAPSHOT` may need to be built with `buildBriefSnapshot` + `BUILTIN_BRIEF_TEMPLATES` if the file does not have them yet).

Run the file. Expected: the two new tests FAIL.

- [ ] **Step 4: Wire the script into the editorial pass**

In `lib/rough-cut/assemble-job.ts`:

- Imports: `alignBeatToScript, parseScript, rankingWithScript, scriptCoverageWarnings, scriptTakeGroups` from `./script`; `TAKE_WINDOW_SECONDS` from `./takes`.
- `editorialPass` options gain `script: string | null`. Right after `const fillers = fillerWordsFor(language);` add:

```ts
const scriptLines = options.script ? parseScript(options.script, fillers) : [];
if (options.script && scriptLines.length === 0) {
  warnings.push({
    code: 'script-unreadable',
    message: 'The script has no line of three or more words, so it was not used',
  });
}
if (scriptLines.length > 0 && !editorial.takeSelection) {
  warnings.push({
    code: 'script-ignored',
    message: 'The brief does not select takes, so the script was not used',
  });
}
```

- Inside `if (editorial.takeSelection && transcripts.length > 0) {`: replace the `script-match-unavailable` warning with `const useScript = scriptLines.length > 0;` and keep the warning only `if (!useScript && editorial.ranking.includes('script_match'))`. After building `candidates`:

```ts
const alignments = useScript
  ? candidates.map((candidate) => alignBeatToScript(candidate.beat, scriptLines, fillers))
  : [];
alignments.forEach((alignment, index) => {
  candidates[index]!.scriptMatch = alignment.score;
});
const ranking = useScript ? rankingWithScript(editorial.ranking) : editorial.ranking;
const alsoGroup = useScript ? scriptTakeGroups(candidates, alignments, TAKE_WINDOW_SECONDS) : [];
const options_ = { fillers, ranking, longPauseSeconds, alsoGroup };
```

(`ranking` replaces `editorial.ranking` in the two `selectTakes` calls that follow, and the energy pre-pass checks `ranking.includes('energy')`.) After the `rejected` beats are removed from `beatsByVersion`, add:

```ts
if (useScript) {
  const keptAlignments = alignments.filter((_, index) => !rejected.has(candidates[index]!.beat));
  warnings.push(...scriptCoverageWarnings(scriptLines, keptAlignments));
}
```

- Both callers pass `script`: `assembleLinearLayout` gets `script: string | null` in its options and forwards it; the multicam call site passes `script: readScript(cut.script)` where `const readScript = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);` (define once near `readLayout`).

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-assemble-job.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run `bun run test` and `bun run check`.

```bash
git add lib tests
git commit -m "feat(rough-cut): match takes against the script and catch partial retakes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Reviewer overrides and `applyOverrides`

**Files:**

- Create: `lib/rough-cut/overrides.ts`
- Test: `tests/unit/lib/rough-cut-overrides.test.ts`

Context: every removal the assembler makes is a keyed cut island on the decision list (`cuts[].key = ${sourceVersionId}:${inFrame}-${outFrame}`). The reviewer's decisions are stored on the run as overrides: `restore` puts an island back, `keep` records that it was looked at, and extra cuts remove more material, expressed in source time so they survive a re-render. `applyOverrides` is pure and produces the program that materialization renders. All layouts leave assembly packed tight, so ordering edits by the continuous axis (clip offset plus source in-point) works for every layout.

- [ ] **Step 1: Failing tests**

Create `tests/unit/lib/rough-cut-overrides.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import {
  applyOverrides,
  emptyOverrides,
  extraCutKey,
  hasProgramChanges,
  overrideSummary,
  overridesEqual,
  parseRoughCutOverrides,
  validateOverridesForDecisions,
} from '@/lib/rough-cut/overrides';
import { cutIslandKey } from '@/lib/rough-cut/program';
import type { CameraClip, EditDecision, RoughCutDecisionList } from '@/lib/rough-cut/types';

const RATE = { num: 25, den: 1, dropFrame: false };

function clip(versionId: string, offsetSeconds = 0, role = 'A'): CameraClip {
  return {
    videoId: `video-${versionId}`,
    versionId,
    title: versionId,
    role,
    position: 0,
    offsetSeconds,
    durationSeconds: 30,
    frameRateNum: 25,
    frameRateDen: 1,
    dropFrame: false,
    startTimecode: null,
    originalUrl: `/api/upload/video/${versionId}.mp4`,
    versionNumber: 1,
    versionLabel: null,
  };
}

function edit(
  timelineStart: number,
  inSeconds: number,
  outSeconds: number,
  sourceVersionId = 'v1',
  cameraRole = 'A'
): EditDecision {
  return {
    timelineStartSeconds: timelineStart,
    timelineEndSeconds: timelineStart + (outSeconds - inSeconds),
    inSeconds,
    outSeconds,
    sourceVersionId,
    cameraRole,
    targetTrack: 1,
    reason: { code: 'KEPT', summary: 'Speech' },
  };
}

/** A linear cut of one clip: speech at 1–4 and 6–10, dead air 4–6 removed. */
function linearDecisions(): RoughCutDecisionList {
  return assembleDecisionList({
    edits: [edit(0, 1, 4), edit(3, 6, 10)],
    clips: [clip('v1')],
    fileNames: new Map([['v1', '01-v1.mp4']]),
    mediaPathPrefix: './media/',
    rate: RATE,
    cuts: [
      {
        key: cutIslandKey('v1', 4, 6, RATE),
        sourceVersionId: 'v1',
        inSeconds: 4,
        outSeconds: 6,
        reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
        transcriptText: null,
      },
    ],
  });
}

const ISLAND = cutIslandKey('v1', 4, 6, RATE);

describe('parseRoughCutOverrides', () => {
  it('reads a stored value and refuses anything malformed', () => {
    expect(parseRoughCutOverrides(null)).toBeNull();
    expect(parseRoughCutOverrides({ version: 1, cuts: { [ISLAND]: 'restore' } })).toEqual({
      version: 1,
      cuts: { [ISLAND]: 'restore' },
      extraCuts: [],
    });
    expect(parseRoughCutOverrides({ version: 2, cuts: {} })).toBeNull();
    expect(parseRoughCutOverrides({ version: 1, cuts: { [ISLAND]: 'delete' } })).toBeNull();
  });
});

describe('validateOverridesForDecisions', () => {
  it('rejects a key the run does not have and a cut outside its clips', () => {
    const decisions = linearDecisions();
    const unknown = validateOverridesForDecisions(
      { version: 1, cuts: { 'v1:0-1': 'restore' } },
      decisions
    );
    expect(unknown).toEqual({ ok: false, error: 'Unknown cut keys: v1:0-1' });
    const foreign = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v9', inSeconds: 1, outSeconds: 2 }] },
      decisions
    );
    expect(foreign.ok).toBe(false);
    const pastEnd = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 29, outSeconds: 31 }] },
      decisions
    );
    expect(pastEnd.ok).toBe(false);
  });

  it('derives extra cut keys itself and drops duplicates', () => {
    const decisions = linearDecisions();
    const result = validateOverridesForDecisions(
      {
        version: 1,
        cuts: { [ISLAND]: 'keep' },
        extraCuts: [
          {
            key: 'client-made-this-up',
            sourceVersionId: 'v1',
            inSeconds: 2,
            outSeconds: 3,
            note: ' too slow ',
          },
          { sourceVersionId: 'v1', inSeconds: 2, outSeconds: 3 },
        ],
      },
      decisions
    );
    expect(result).toEqual({
      ok: true,
      value: {
        version: 1,
        cuts: { [ISLAND]: 'keep' },
        extraCuts: [
          {
            key: extraCutKey('v1', 2, 3, RATE),
            sourceVersionId: 'v1',
            inSeconds: 2,
            outSeconds: 3,
            note: 'too slow',
          },
        ],
      },
    });
    expect(extraCutKey('v1', 2, 3, RATE)).toBe('manual:v1:50-75');
  });
});

describe('applyOverrides', () => {
  it('returns the same list when nothing changes the program', () => {
    const decisions = linearDecisions();
    expect(applyOverrides(decisions, null)).toBe(decisions);
    expect(applyOverrides(decisions, { ...emptyOverrides(), cuts: { [ISLAND]: 'keep' } })).toBe(
      decisions
    );
    expect(hasProgramChanges({ ...emptyOverrides(), cuts: { [ISLAND]: 'keep' } })).toBe(false);
  });

  it('puts a restored island back in source order, merges it with its neighbour and re-packs', () => {
    const decisions = linearDecisions();
    const result = applyOverrides(decisions, {
      ...emptyOverrides(),
      cuts: { [ISLAND]: 'restore' },
    });
    expect(result.edits).toEqual([
      expect.objectContaining({
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
        inSeconds: 1,
        outSeconds: 4,
      }),
      expect.objectContaining({
        timelineStartSeconds: 3,
        timelineEndSeconds: 9,
        inSeconds: 4,
        outSeconds: 10,
        reason: { code: 'KEPT', summary: 'Restored by the reviewer' },
      }),
    ]);
    expect(result.cuts).toEqual(decisions.cuts);
  });

  it('splits an edit around an extra cut', () => {
    const decisions = linearDecisions();
    const result = applyOverrides(decisions, {
      ...emptyOverrides(),
      extraCuts: [
        {
          key: extraCutKey('v1', 7, 8, RATE),
          sourceVersionId: 'v1',
          inSeconds: 7,
          outSeconds: 8,
          note: null,
        },
      ],
    });
    expect(
      result.edits.map((entry) => [
        entry.timelineStartSeconds,
        entry.timelineEndSeconds,
        entry.inSeconds,
        entry.outSeconds,
      ])
    ).toEqual([
      [0, 3, 1, 4],
      [3, 4, 6, 7],
      [4, 6, 8, 10],
    ]);
  });

  it('orders a multicam restore by the clip offset, not by source time alone', () => {
    const decisions = assembleDecisionList({
      edits: [edit(0, 0, 5, 'wide', 'WIDE'), edit(5, 12, 15, 'cam', 'A')],
      clips: [clip('wide', 0, 'WIDE'), clip('cam', -5, 'A')],
      fileNames: new Map([
        ['wide', '01-wide.mp4'],
        ['cam', '02-cam.mp4'],
      ]),
      mediaPathPrefix: './media/',
      rate: RATE,
      cuts: [
        {
          key: cutIslandKey('wide', 5, 7, RATE),
          sourceVersionId: 'wide',
          inSeconds: 5,
          outSeconds: 7,
          reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
          transcriptText: null,
        },
      ],
    });
    const result = applyOverrides(decisions, {
      ...emptyOverrides(),
      cuts: { [cutIslandKey('wide', 5, 7, RATE)]: 'restore' },
    });
    expect(
      result.edits.map((entry) => [
        entry.sourceVersionId,
        entry.timelineStartSeconds,
        entry.timelineEndSeconds,
        entry.inSeconds,
      ])
    ).toEqual([
      ['wide', 0, 7, 0],
      ['cam', 7, 10, 12],
    ]);
  });
});

describe('overrideSummary / overridesEqual', () => {
  it('counts decisions and program length', () => {
    const decisions = linearDecisions();
    const overrides = { ...emptyOverrides(), cuts: { [ISLAND]: 'restore' as const } };
    expect(overrideSummary(decisions, overrides)).toEqual({
      restored: 1,
      kept: 0,
      extraCuts: 0,
      originalSeconds: 7,
      programSeconds: 9,
    });
    expect(
      overridesEqual(overrides, { version: 1, cuts: { [ISLAND]: 'restore' }, extraCuts: [] })
    ).toBe(true);
    expect(overridesEqual(overrides, null)).toBe(false);
    expect(overridesEqual(null, null)).toBe(true);
  });
});
```

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-overrides.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 2: Implement the module**

Create `lib/rough-cut/overrides.ts`:

```ts
import { z } from 'zod';
import type { FrameRate } from '../timecode';
import { cutIslandKey, packTimeline } from './program';
import type { EditDecision, EditReason, RoughCutDecisionList } from './types';

/**
 * The reviewer's decisions on a run, stored on the RoughCut row and applied
 * by materialization. Islands are addressed by the key assembly gave them;
 * extra cuts are source ranges, so both survive a re-render. Pure, and
 * copied into the worker image with the rest of lib/rough-cut.
 */

export const CUT_OVERRIDE_ACTIONS = ['restore', 'keep'] as const;
export type CutOverrideAction = (typeof CUT_OVERRIDE_ACTIONS)[number];

export type ExtraCut = {
  key: string;
  sourceVersionId: string;
  inSeconds: number;
  outSeconds: number;
  note: string | null;
};

export type RoughCutOverrides = {
  version: 1;
  cuts: Record<string, CutOverrideAction>;
  extraCuts: ExtraCut[];
};

export const MAX_EXTRA_CUTS = 200;
export const MIN_EXTRA_CUT_SECONDS = 0.1;
const NOTE_MAX = 300;
const EPSILON = 1e-6;

const RESTORED: EditReason = { code: 'KEPT', summary: 'Restored by the reviewer' };

export const roughCutOverridesSchema = z
  .object({
    version: z.literal(1),
    cuts: z.record(z.string().min(1), z.enum(CUT_OVERRIDE_ACTIONS)).default({}),
    extraCuts: z
      .array(
        z
          .object({
            key: z.string().min(1).optional(),
            sourceVersionId: z.string().min(1),
            inSeconds: z.number().finite().nonnegative(),
            outSeconds: z.number().finite().nonnegative(),
            note: z.string().trim().max(NOTE_MAX).nullable().optional(),
          })
          .strict()
      )
      .max(MAX_EXTRA_CUTS)
      .default([]),
  })
  .strict();

export function emptyOverrides(): RoughCutOverrides {
  return { version: 1, cuts: {}, extraCuts: [] };
}

/** Stable across renders: the island key convention with a prefix that says a person drew it. */
export function extraCutKey(
  sourceVersionId: string,
  inSeconds: number,
  outSeconds: number,
  rate: FrameRate
): string {
  return `manual:${cutIslandKey(sourceVersionId, inSeconds, outSeconds, rate)}`;
}

/** Read the stored column. A malformed value reads as no overrides rather than failing the render. */
export function parseRoughCutOverrides(value: unknown): RoughCutOverrides | null {
  if (value === null || value === undefined) return null;
  const parsed = roughCutOverridesSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    version: 1,
    cuts: parsed.data.cuts,
    extraCuts: parsed.data.extraCuts.map((cut) => ({
      key: cut.key ?? '',
      sourceVersionId: cut.sourceVersionId,
      inSeconds: cut.inSeconds,
      outSeconds: cut.outSeconds,
      note: cut.note ?? null,
    })),
  };
}

export type OverridesValidation =
  | { ok: true; value: RoughCutOverrides }
  | { ok: false; error: string };

/**
 * A body from the review UI checked against the run it is for: every key
 * must name one of the run's islands and every extra cut must lie inside
 * one of its clips. Extra cut keys are derived here, never trusted.
 */
export function validateOverridesForDecisions(
  input: unknown,
  decisions: RoughCutDecisionList
): OverridesValidation {
  const parsed = roughCutOverridesSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
    return { ok: false, error: `${path}${first?.message ?? 'Invalid overrides'}` };
  }
  const islandKeys = new Set((decisions.cuts ?? []).map((cut) => cut.key));
  const unknown = Object.keys(parsed.data.cuts).filter((key) => !islandKeys.has(key));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown cut keys: ${unknown.slice(0, 5).join(', ')}` };
  }
  const clips = new Map(decisions.clips.map((clip) => [clip.versionId, clip]));
  const extraCuts: ExtraCut[] = [];
  const seen = new Set<string>();
  for (const cut of parsed.data.extraCuts) {
    const clip = clips.get(cut.sourceVersionId);
    if (!clip) {
      return { ok: false, error: `extraCuts: ${cut.sourceVersionId} is not a clip of this cut` };
    }
    if (cut.outSeconds - cut.inSeconds < MIN_EXTRA_CUT_SECONDS) {
      return {
        ok: false,
        error: `extraCuts: a cut must be at least ${MIN_EXTRA_CUT_SECONDS}s long`,
      };
    }
    if (clip.durationSeconds > EPSILON && cut.outSeconds > clip.durationSeconds + EPSILON) {
      return { ok: false, error: `extraCuts: ${cut.outSeconds}s is past the end of the clip` };
    }
    const key = extraCutKey(cut.sourceVersionId, cut.inSeconds, cut.outSeconds, decisions.rate);
    if (seen.has(key)) continue;
    seen.add(key);
    extraCuts.push({
      key,
      sourceVersionId: cut.sourceVersionId,
      inSeconds: cut.inSeconds,
      outSeconds: cut.outSeconds,
      note: cut.note ?? null,
    });
  }
  return { ok: true, value: { version: 1, cuts: parsed.data.cuts, extraCuts } };
}

export function hasProgramChanges(overrides: RoughCutOverrides | null): boolean {
  if (!overrides) return false;
  if (overrides.extraCuts.length > 0) return true;
  return Object.values(overrides.cuts).some((action) => action === 'restore');
}

function subtractSourceRange(
  edits: EditDecision[],
  cut: { sourceVersionId: string; inSeconds: number; outSeconds: number }
): EditDecision[] {
  const out: EditDecision[] = [];
  for (const edit of edits) {
    const misses =
      edit.sourceVersionId !== cut.sourceVersionId ||
      cut.outSeconds <= edit.inSeconds + EPSILON ||
      cut.inSeconds >= edit.outSeconds - EPSILON;
    if (misses) {
      out.push(edit);
      continue;
    }
    if (cut.inSeconds > edit.inSeconds + EPSILON) {
      out.push({
        ...edit,
        outSeconds: cut.inSeconds,
        timelineEndSeconds: edit.timelineStartSeconds + (cut.inSeconds - edit.inSeconds),
      });
    }
    if (cut.outSeconds < edit.outSeconds - EPSILON) {
      out.push({
        ...edit,
        inSeconds: cut.outSeconds,
        timelineStartSeconds: edit.timelineStartSeconds + (cut.outSeconds - edit.inSeconds),
      });
    }
  }
  return out;
}

/** Two edits that continue each other in the same source and camera become one. */
function mergeContiguous(edits: EditDecision[]): EditDecision[] {
  const out: EditDecision[] = [];
  for (const edit of edits) {
    const last = out[out.length - 1];
    if (
      last &&
      last.sourceVersionId === edit.sourceVersionId &&
      last.cameraRole === edit.cameraRole &&
      Math.abs(last.outSeconds - edit.inSeconds) < EPSILON
    ) {
      out[out.length - 1] = {
        ...last,
        outSeconds: edit.outSeconds,
        timelineEndSeconds: last.timelineEndSeconds + (edit.outSeconds - edit.inSeconds),
        reason: edit.reason?.summary === RESTORED.summary ? edit.reason : last.reason,
      };
    } else {
      out.push({ ...edit });
    }
  }
  return out;
}

/**
 * The program after the reviewer's decisions: restored islands go back where
 * their source time puts them, extra cuts come out, and the timeline is
 * packed again. Every layout leaves assembly packed tight, so the continuous
 * axis (clip offset plus source in-point) orders edits for all of them.
 * Markers keep the timeline positions assembly gave them; the review UI does
 * not depend on them after a change.
 */
export function applyOverrides(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): RoughCutDecisionList {
  if (!overrides || !hasProgramChanges(overrides)) return decisions;
  const clips = new Map(decisions.clips.map((clip) => [clip.versionId, clip]));
  const axis = (edit: EditDecision) =>
    (clips.get(edit.sourceVersionId)?.offsetSeconds ?? 0) + edit.inSeconds;

  let edits: EditDecision[] = decisions.edits.map((edit) => ({ ...edit }));
  for (const island of decisions.cuts ?? []) {
    if (overrides.cuts[island.key] !== 'restore') continue;
    const clip = clips.get(island.sourceVersionId);
    edits.push({
      timelineStartSeconds: 0,
      timelineEndSeconds: island.outSeconds - island.inSeconds,
      inSeconds: island.inSeconds,
      outSeconds: island.outSeconds,
      sourceVersionId: island.sourceVersionId,
      cameraRole: clip?.role ?? 'A',
      targetTrack: clip?.track ?? 1,
      reason: RESTORED,
    });
  }
  for (const cut of overrides.extraCuts) {
    edits = subtractSourceRange(edits, cut);
  }
  edits = edits
    .filter((edit) => edit.outSeconds - edit.inSeconds > EPSILON)
    .sort((a, b) => axis(a) - axis(b));
  return { ...decisions, edits: packTimeline(mergeContiguous(edits)) };
}

export type OverrideSummary = {
  restored: number;
  kept: number;
  extraCuts: number;
  originalSeconds: number;
  programSeconds: number;
};

function programSeconds(edits: EditDecision[]): number {
  return edits.reduce((sum, edit) => sum + (edit.outSeconds - edit.inSeconds), 0);
}

export function overrideSummary(
  decisions: RoughCutDecisionList,
  overrides: RoughCutOverrides | null
): OverrideSummary {
  const actions = Object.values(overrides?.cuts ?? {});
  return {
    restored: actions.filter((action) => action === 'restore').length,
    kept: actions.filter((action) => action === 'keep').length,
    extraCuts: overrides?.extraCuts.length ?? 0,
    originalSeconds: programSeconds(decisions.edits),
    programSeconds: programSeconds(applyOverrides(decisions, overrides).edits),
  };
}

function canonical(overrides: RoughCutOverrides | null): string {
  if (!overrides) return '';
  const cuts = Object.keys(overrides.cuts)
    .sort()
    .map((key) => `${key}=${overrides.cuts[key]}`);
  const extra = overrides.extraCuts
    .map((cut) => `${cut.sourceVersionId}:${cut.inSeconds}-${cut.outSeconds}`)
    .sort();
  return JSON.stringify({ cuts, extra });
}

/** Same decisions, whatever the key order; notes do not count. */
export function overridesEqual(a: RoughCutOverrides | null, b: RoughCutOverrides | null): boolean {
  return canonical(a) === canonical(b);
}
```

Run the test file. Expected: PASS. Note the `mergeContiguous` reason rule: when a restored piece merges into a neighbour, the merged edit carries the restored reason so the review UI can still show it as restored; the test expects that.

- [ ] **Step 3: Commit**

Run `bun run check`.

```bash
git add lib/rough-cut/overrides.ts tests/unit/lib/rough-cut-overrides.test.ts
git commit -m "feat(rough-cut): reviewer overrides with a pure applyOverrides

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Review API (overrides, render, review payload)

**Files:**

- Create: `lib/rough-cut/review.ts`
- Create: `app/api/rough-cuts/[roughCutId]/overrides/route.ts`
- Create: `app/api/rough-cuts/[roughCutId]/render/route.ts`
- Create: `app/api/videos/[videoId]/rough-cut/route.ts`
- Modify: `app/api/rough-cuts/[roughCutId]/route.ts` (`?include=review`)
- Modify: `tests/api/auth-matrix.test.ts` (three new route files)
- Test: `tests/api/rough-cut-review.test.ts`

Context: the review pane on the output video needs, in one payload, the run's decision list (islands with reasons and transcript text), the reviewer's saved overrides, what was last rendered, the effective program (`applyOverrides`), the source clips with playable URLs, and whether a render is queued. Saving overrides and rendering are separate calls, both editor-only. The output video is found by `RoughCut.outputVideoId`.

- [ ] **Step 1: Failing API tests**

Create `tests/api/rough-cut-review.test.ts`. Seed with the helpers `tests/api/rough-cuts.test.ts` uses (`seedProject`, `createVideo`, `createVersion`, `createRoughCut`, `createUser`, `addProjectMember`), a READY run with `sampleDecisions`-style decisions that include one cut island, and `outputVideoId` pointing at a second video. `createRoughCut` in `tests/factories/rough-cut.ts` needs two new optional fields: `outputVideoId?: string | null` and `overrides?: object | null`; add them.

```ts
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import { cutIslandKey } from '@/lib/rough-cut/program';
import { PUT as putOverrides } from '@/app/api/rough-cuts/[roughCutId]/overrides/route';
import { POST as postRender } from '@/app/api/rough-cuts/[roughCutId]/render/route';
import { GET as getRoughCut } from '@/app/api/rough-cuts/[roughCutId]/route';
import { GET as getVideoRoughCut } from '@/app/api/videos/[videoId]/rough-cut/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createRoughCut,
  createUser,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';

const RATE = { num: 24, den: 1, dropFrame: false };

async function seedReviewableCut() {
  const scenario = await seedProject();
  const source = await createVideo({ projectId: scenario.project.id, title: 'Cam A' });
  const sourceVersion = await createVersion({
    videoParentId: source.id,
    providerId: 'r2',
    providerVideoId: 'videos/cam-a.mp4',
    originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    duration: 30,
  });
  const output = await createVideo({ projectId: scenario.project.id, title: 'Rough cut' });
  const outputVersion = await createVersion({
    videoParentId: output.id,
    providerId: 'r2',
    providerVideoId: 'videos/out.mp4',
    originalUrl: '/api/upload/video/cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
  });
  const islandKey = cutIslandKey(sourceVersion.id, 4, 6, RATE);
  const decisions = assembleDecisionList({
    edits: [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: sourceVersion.id,
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 3,
        timelineEndSeconds: 7,
        inSeconds: 6,
        outSeconds: 10,
        sourceVersionId: sourceVersion.id,
        cameraRole: 'A',
        targetTrack: 1,
      },
    ],
    clips: [
      {
        videoId: source.id,
        versionId: sourceVersion.id,
        title: 'Cam A',
        role: 'A',
        position: 0,
        offsetSeconds: 0,
        durationSeconds: 30,
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        startTimecode: null,
        originalUrl: sourceVersion.originalUrl,
        versionNumber: 1,
        versionLabel: null,
      },
    ],
    fileNames: new Map([[sourceVersion.id, '01-Cam A-v1.mp4']]),
    mediaPathPrefix: './media/',
    rate: RATE,
    cuts: [
      {
        key: islandKey,
        sourceVersionId: sourceVersion.id,
        inSeconds: 4,
        outSeconds: 6,
        reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
        transcriptText: null,
      },
    ],
  });
  const cut = await createRoughCut({
    projectId: scenario.project.id,
    requestedById: scenario.owner.id,
    status: 'READY',
    layout: 'LINEAR',
    decisions,
    outputVideoId: output.id,
  });
  return { ...scenario, source, sourceVersion, output, outputVersion, cut, islandKey };
}

describe('PUT /api/rough-cuts/[roughCutId]/overrides', () => {
  it('returns 401 to an anonymous caller and stores nothing', async () => {
    const seeded = await seedReviewableCut();
    signedOut();
    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: { version: 1, cuts: { [seeded.islandKey]: 'restore' } },
      }),
      { roughCutId: seeded.cut.id }
    );
    expect(response.status).toBe(401);
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } })).overrides
    ).toBeNull();
  });

  it('returns 403 to a viewer member and stores nothing', async () => {
    const seeded = await seedReviewableCut();
    const viewer = await createUser();
    await addProjectMember({ projectId: seeded.project.id, userId: viewer.id, role: 'VIEWER' });
    signedInAs(viewer);
    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: { version: 1, cuts: { [seeded.islandKey]: 'restore' } },
      }),
      { roughCutId: seeded.cut.id }
    );
    expect(response.status).toBe(403);
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } })).overrides
    ).toBeNull();
  });

  it('stores validated overrides for the owner and reports the effective program', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);
    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: {
          version: 1,
          cuts: { [seeded.islandKey]: 'restore' },
          extraCuts: [{ sourceVersionId: seeded.sourceVersion.id, inSeconds: 7, outSeconds: 8 }],
        },
      }),
      { roughCutId: seeded.cut.id }
    );
    expect(response.status).toBe(200);
    const payload = await readData<{
      overrides: { cuts: Record<string, string>; extraCuts: Array<{ key: string }> };
      summary: { restored: number; extraCuts: number; programSeconds: number };
      needsRender: boolean;
    }>(response);
    expect(payload.summary).toMatchObject({ restored: 1, extraCuts: 1, programSeconds: 8 });
    expect(payload.needsRender).toBe(true);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } });
    expect(stored.overrides).toMatchObject({ version: 1, cuts: { [seeded.islandKey]: 'restore' } });
    expect(payload.overrides.extraCuts[0]?.key).toMatch(/^manual:/);
  });

  it('rejects an unknown island key with 400 and stores nothing', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);
    const response = await callRoute(
      putOverrides,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/overrides`, {
        method: 'PUT',
        body: { version: 1, cuts: { 'nope:1-2': 'restore' } },
      }),
      { roughCutId: seeded.cut.id }
    );
    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Unknown cut keys');
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: seeded.cut.id } })).overrides
    ).toBeNull();
  });
});

describe('POST /api/rough-cuts/[roughCutId]/render', () => {
  it('returns 401 anonymously and 403 to a viewer, enqueuing nothing', async () => {
    const seeded = await seedReviewableCut();
    signedOut();
    expect(
      (
        await callRoute(
          postRender,
          apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
          { roughCutId: seeded.cut.id }
        )
      ).status
    ).toBe(401);
    const viewer = await createUser();
    await addProjectMember({ projectId: seeded.project.id, userId: viewer.id, role: 'VIEWER' });
    signedInAs(viewer);
    expect(
      (
        await callRoute(
          postRender,
          apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
          { roughCutId: seeded.cut.id }
        )
      ).status
    ).toBe(403);
    expect(await db.mediaJob.count({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } })).toBe(0);
  });

  it('enqueues one materialize job for the owner and refuses a second while it is pending', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);
    const first = await callRoute(
      postRender,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
      { roughCutId: seeded.cut.id }
    );
    expect(first.status).toBe(202);
    const jobs = await db.mediaJob.findMany({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.versionId).toBe(seeded.sourceVersion.id);
    expect(jobs[0]?.payload).toEqual({ roughCutId: seeded.cut.id });
    const second = await callRoute(
      postRender,
      apiRequest(`/api/rough-cuts/${seeded.cut.id}/render`, { method: 'POST' }),
      { roughCutId: seeded.cut.id }
    );
    expect(second.status).toBe(409);
    expect(await db.mediaJob.count({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } })).toBe(1);
  });
});

describe('GET /api/videos/[videoId]/rough-cut', () => {
  it('returns 403 to an anonymous caller on a private project', async () => {
    const seeded = await seedReviewableCut();
    signedOut();
    const response = await callRoute(
      getVideoRoughCut,
      apiRequest(`/api/videos/${seeded.output.id}/rough-cut`),
      { videoId: seeded.output.id }
    );
    expect(response.status).toBe(403);
  });

  it('returns null for a video that is not a rough-cut output', async () => {
    const seeded = await seedReviewableCut();
    signedInAs(seeded.owner);
    const response = await callRoute(
      getVideoRoughCut,
      apiRequest(`/api/videos/${seeded.source.id}/rough-cut`),
      { videoId: seeded.source.id }
    );
    expect(response.status).toBe(200);
    expect(await readData<{ roughCut: unknown }>(response)).toEqual({ roughCut: null });
  });

  it('returns the review payload with sources, islands, the effective program and render state', async () => {
    const seeded = await seedReviewableCut();
    await db.roughCut.update({
      where: { id: seeded.cut.id },
      data: { overrides: { version: 1, cuts: { [seeded.islandKey]: 'restore' }, extraCuts: [] } },
    });
    signedInAs(seeded.owner);
    const response = await callRoute(
      getVideoRoughCut,
      apiRequest(`/api/videos/${seeded.output.id}/rough-cut`),
      { videoId: seeded.output.id }
    );
    expect(response.status).toBe(200);
    const payload = await readData<{
      roughCut: { id: string };
      canEdit: boolean;
      review: {
        decisions: { cuts: Array<{ key: string }> };
        effective: { edits: Array<{ inSeconds: number; outSeconds: number }> };
        overrides: { cuts: Record<string, string> } | null;
        renderedOverrides: unknown;
        needsRender: boolean;
        sources: Array<{
          versionId: string;
          title: string;
          playbackUrl: string | null;
          playbackKind: string | null;
        }>;
        render: { status: string };
      };
    }>(response);
    expect(payload.roughCut.id).toBe(seeded.cut.id);
    expect(payload.canEdit).toBe(true);
    expect(payload.review.decisions.cuts.map((cut) => cut.key)).toEqual([seeded.islandKey]);
    expect(payload.review.effective.edits.map((edit) => [edit.inSeconds, edit.outSeconds])).toEqual(
      [[1, 10]]
    );
    expect(payload.review.overrides?.cuts).toEqual({ [seeded.islandKey]: 'restore' });
    expect(payload.review.needsRender).toBe(true);
    expect(payload.review.sources).toEqual([
      expect.objectContaining({
        versionId: seeded.sourceVersion.id,
        title: 'Cam A',
        playbackUrl: seeded.sourceVersion.originalUrl,
        playbackKind: 'file',
      }),
    ]);
    expect(payload.review.render.status).toBe('idle');
  });
});
```

Add the three new route files to `tests/api/auth-matrix.test.ts` following its entry shape (`file`, `module`, `url`, `params`, `body` for PUT/POST). The fixture already has `roughCutId` and `videoId`. The overrides entry body: `{ version: 1, cuts: {} }`. Run that suite too.

Run: `DATABASE_URL="postgresql://openframe:openframe@127.0.0.1:55432/openframe_test?schema=public" bun run vitest run --project api tests/api/rough-cut-review.test.ts tests/api/auth-matrix.test.ts`
Expected: FAIL (routes missing).

- [ ] **Step 2: The review payload builder**

Create `lib/rough-cut/review.ts`:

```ts
import { MediaJobKind, MediaJobStatus, type Prisma, type RoughCut } from '@prisma/client';
import { db } from '@/lib/db';
import { resolvePublicBunnyCdnHostname } from '@/lib/bunny-cdn';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import {
  applyOverrides,
  overridesEqual,
  parseRoughCutOverrides,
  type RoughCutOverrides,
} from '@/lib/rough-cut/overrides';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';
import { resolveR2PlaybackUrl } from '@/lib/video-upload-validation';

export type RoughCutReviewSource = {
  versionId: string;
  videoId: string;
  title: string;
  role: string;
  offsetSeconds: number;
  durationSeconds: number;
  playbackUrl: string | null;
  playbackKind: 'file' | 'hls' | null;
};

export type RoughCutRenderState = {
  status: 'idle' | 'queued' | 'running' | 'failed';
  error: string | null;
  updatedAt: string | null;
};

export type RoughCutReview = {
  decisions: RoughCutDecisionList;
  effective: RoughCutDecisionList;
  overrides: RoughCutOverrides | null;
  renderedOverrides: RoughCutOverrides | null;
  renderedDecisions: RoughCutDecisionList | null;
  needsRender: boolean;
  script: string | null;
  sources: RoughCutReviewSource[];
  render: RoughCutRenderState;
};

const ACTIVE_JOB: MediaJobStatus[] = [
  MediaJobStatus.PENDING,
  MediaJobStatus.QUEUED,
  MediaJobStatus.RUNNING,
];

export function materializeJobWhere(roughCutId: string): Prisma.MediaJobWhereInput {
  return {
    kind: MediaJobKind.MATERIALIZE_ROUGH_CUT,
    payload: { path: ['roughCutId'], equals: roughCutId },
  };
}

export async function findActiveMaterializeJob(roughCutId: string) {
  return db.mediaJob.findFirst({
    where: { ...materializeJobWhere(roughCutId), status: { in: ACTIVE_JOB } },
    select: { id: true, status: true },
  });
}

async function renderState(roughCutId: string): Promise<RoughCutRenderState> {
  const job = await db.mediaJob.findFirst({
    where: materializeJobWhere(roughCutId),
    orderBy: { createdAt: 'desc' },
    select: { status: true, error: true, updatedAt: true },
  });
  if (!job) return { status: 'idle', error: null, updatedAt: null };
  const status =
    job.status === MediaJobStatus.RUNNING
      ? 'running'
      : job.status === MediaJobStatus.FAILED
        ? 'failed'
        : job.status === MediaJobStatus.SUCCEEDED
          ? 'idle'
          : 'queued';
  return { status, error: job.error, updatedAt: job.updatedAt.toISOString() };
}

async function loadSources(decisions: RoughCutDecisionList): Promise<RoughCutReviewSource[]> {
  const versionIds = decisions.clips.map((clip) => clip.versionId);
  const versions = await db.videoVersion.findMany({
    where: { id: { in: versionIds } },
    select: {
      id: true,
      videoId: true,
      providerId: true,
      originalUrl: true,
      proxyUrl: true,
      proxyStatus: true,
      duration: true,
      video: { select: { id: true, title: true } },
    },
  });
  const byId = new Map(versions.map((version) => [version.id, version]));
  const bunnyHost = resolvePublicBunnyCdnHostname();
  return decisions.clips.map((clip) => {
    const version = byId.get(clip.versionId);
    let playbackUrl: string | null = null;
    let playbackKind: RoughCutReviewSource['playbackKind'] = null;
    if (version?.providerId === 'r2') {
      playbackUrl = resolveR2PlaybackUrl(version);
      playbackKind = 'file';
    } else if (version?.providerId === 'bunny' && bunnyHost) {
      playbackUrl = `https://${bunnyHost}/${version.videoId}/playlist.m3u8`;
      playbackKind = 'hls';
    }
    return {
      versionId: clip.versionId,
      videoId: clip.videoId,
      title: version?.video.title ?? clip.role,
      role: clip.role,
      offsetSeconds: clip.offsetSeconds,
      durationSeconds: clip.durationSeconds || version?.duration || 0,
      playbackUrl,
      playbackKind,
    };
  });
}

/** Everything the review pane needs about a READY run, or null when it has no decisions yet. */
export async function loadRoughCutReview(row: RoughCut): Promise<RoughCutReview | null> {
  const decisions = parseRoughCutDecisionList(row.decisions);
  if (!decisions) return null;
  const overrides = parseRoughCutOverrides(row.overrides);
  const renderedOverrides = parseRoughCutOverrides(row.renderedOverrides);
  const [sources, render] = await Promise.all([loadSources(decisions), renderState(row.id)]);
  return {
    decisions,
    effective: applyOverrides(decisions, overrides),
    overrides,
    renderedOverrides,
    renderedDecisions: parseRoughCutDecisionList(row.renderedDecisions),
    needsRender: !overridesEqual(overrides, renderedOverrides),
    script: row.script ?? null,
    sources,
    render,
  };
}
```

Check the exact `resolveR2PlaybackUrl` parameter shape in `lib/video-upload-validation.ts` (it takes `{ videoId, originalUrl, proxyUrl?, proxyStatus? }`) and pass a matching object.

- [ ] **Step 3: Routes**

`app/api/rough-cuts/[roughCutId]/overrides/route.ts`:

```ts
import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import {
  overrideSummary,
  overridesEqual,
  parseRoughCutOverrides,
  validateOverridesForDecisions,
} from '@/lib/rough-cut/overrides';

type RouteParams = { params: Promise<{ roughCutId: string }> };

// PUT /api/rough-cuts/[roughCutId]/overrides — save the reviewer's decisions; rendering is a separate call.
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { roughCutId } = await params;
    const row = await db.roughCut.findUnique({
      where: { id: roughCutId },
      include: {
        project: { select: { id: true, ownerId: true, workspaceId: true, visibility: true } },
      },
    });
    if (!row) return apiErrors.notFound('Rough cut');
    const access = await checkProjectAccess(row.project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');
    if (row.status !== 'READY') return apiErrors.badRequest('Rough cut is not ready to review');
    const decisions = parseRoughCutDecisionList(row.decisions);
    if (!decisions) return apiErrors.badRequest('Rough cut has no decisions to review');

    const body = await request.json().catch(() => null);
    const validated = validateOverridesForDecisions(body, decisions);
    if (!validated.ok) return apiErrors.badRequest(validated.error);

    await db.roughCut.update({
      where: { id: roughCutId },
      data: { overrides: validated.value as unknown as Prisma.InputJsonValue },
    });

    return withCacheControl(
      successResponse({
        overrides: validated.value,
        summary: overrideSummary(decisions, validated.value),
        needsRender: !overridesEqual(
          validated.value,
          parseRoughCutOverrides(row.renderedOverrides)
        ),
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error saving rough cut overrides:', error);
    return apiErrors.internalError('Failed to save overrides');
  }
}
```

`app/api/rough-cuts/[roughCutId]/render/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { MediaJobKind } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { rateLimit } from '@/lib/rate-limit';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import { findActiveMaterializeJob } from '@/lib/rough-cut/review';

type RouteParams = { params: Promise<{ roughCutId: string }> };

// POST /api/rough-cuts/[roughCutId]/render — materialize the program with the saved overrides as a new version of the output video.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { roughCutId } = await params;
    const row = await db.roughCut.findUnique({
      where: { id: roughCutId },
      include: {
        project: { select: { id: true, ownerId: true, workspaceId: true, visibility: true } },
      },
    });
    if (!row) return apiErrors.notFound('Rough cut');
    const access = await checkProjectAccess(row.project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');
    if (row.status !== 'READY') return apiErrors.badRequest('Rough cut is not ready to render');
    const decisions = parseRoughCutDecisionList(row.decisions);
    const firstVersionId = decisions?.edits[0]?.sourceVersionId;
    if (!decisions || !firstVersionId)
      return apiErrors.badRequest('Rough cut has nothing to render');

    if (await findActiveMaterializeJob(roughCutId)) {
      return apiErrors.conflict('A render is already running for this cut');
    }

    const jobId = await enqueueMediaJob(firstVersionId, MediaJobKind.MATERIALIZE_ROUGH_CUT, {
      roughCutId,
    });
    return withCacheControl(
      successResponse({ job: { id: jobId, status: 'PENDING' } }, 202),
      'private, no-store'
    );
  } catch (error) {
    logError('Error enqueueing rough cut render:', error);
    return apiErrors.internalError('Failed to start the render');
  }
}
```

`app/api/videos/[videoId]/rough-cut/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { loadRoughCutReview } from '@/lib/rough-cut/review';
import { shapeRoughCut } from '@/lib/rough-cut/serialize';
import { getVideoAssetAccessContext } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string }> };

// GET /api/videos/[videoId]/rough-cut — the run this video is the output of, with everything the review pane needs.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'transcript-read');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.hasViewAccess) return apiErrors.forbidden('Access denied');

    const row = await db.roughCut.findFirst({
      where: { outputVideoId: videoId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return withCacheControl(successResponse({ roughCut: null }), 'private, no-store');

    const review = await loadRoughCutReview(row);
    return withCacheControl(
      successResponse({
        roughCut: shapeRoughCut(row),
        review,
        canEdit: context.canManageAssets,
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error loading rough cut review:', error);
    return apiErrors.internalError('Failed to load the rough cut');
  }
}
```

Check `VideoAssetAccessContext` in `lib/video-assets.ts` for the exact field names (`hasViewAccess`, `canManageAssets`, `viewerUserId`) and use them.

`app/api/rough-cuts/[roughCutId]/route.ts` GET: when `request.nextUrl.searchParams.get('include') === 'review'` add `review: await loadRoughCutReview(loaded.row)` to the response (and pass `{ includeScript: true }` to `shapeRoughCut`, done in Task 2).

Run the two api files. Expected: PASS.

- [ ] **Step 4: Commit**

Run `bun run check`.

```bash
git add app lib tests
git commit -m "feat(rough-cut): overrides, render and review endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Derived transcript and captions on every rendered cut; materialize job moves to lib

**Files:**

- Create: `lib/rough-cut/vtt.ts`
- Create: `lib/rough-cut/caption-track.ts`
- Create: `lib/rough-cut/derived-transcript.ts`
- Create: `lib/rough-cut/materialize-job.ts`
- Modify: `worker/src/materialize-rough-cut.ts` (re-export), `worker/src/index.ts` (use the shared VTT/caption helpers, pass deps)
- Test: `tests/unit/lib/rough-cut-vtt.test.ts`, `tests/unit/lib/rough-cut-derived-transcript.test.ts`, `tests/unit/lib/rough-cut-materialize-job.test.ts`

Context: the rendered cut is a new `Video` whose only job today is `PROBE_MEDIA`, so it arrives with no transcript and the operator ends up re-transcribing it with AI, twice (once for the transcript, once through "Generate AI" captions). Every word of the output already has a timed word in a source transcript; the decision list says where it landed. So materialization derives the output transcript by mapping source words through the edits, stores it as a READY `Transcript` (provider `rough-cut`), and writes the same text as the version's caption track. Re-renders (Task 5) add a version to the existing output video instead of a new video, so v1/v2 can be compared.

- [ ] **Step 1: Failing tests for the pure parts**

`tests/unit/lib/rough-cut-vtt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { serializeWebVtt, toVttTime } from '@/lib/rough-cut/vtt';

describe('vtt', () => {
  it('formats times and cues the way the player expects', () => {
    expect(toVttTime(0)).toBe('00:00:00.000');
    expect(toVttTime(3725.5)).toBe('01:02:05.500');
    expect(toVttTime(-1)).toBe('00:00:00.000');
    expect(serializeWebVtt([{ start: 1, end: 2.25, text: 'Hello' }])).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.250\nHello\n'
    );
  });
});
```

`tests/unit/lib/rough-cut-derived-transcript.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DERIVED_SEGMENT_MAX_WORDS,
  deriveProgramTranscript,
} from '@/lib/rough-cut/derived-transcript';
import type { TranscriptSegmentRow } from '@/lib/rough-cut/transcript-source';
import type { EditDecision } from '@/lib/rough-cut/types';

function timed(at: number, text: string, speaker: string | null = null): TranscriptSegmentRow {
  const words = text.split(' ').map((word, index) => ({
    start: at + index,
    end: at + index + 0.8,
    text: word,
  }));
  return {
    startSec: words[0]!.start,
    endSec: words[words.length - 1]!.end,
    speaker,
    text,
    words,
  };
}

function edit(
  timelineStart: number,
  inSeconds: number,
  outSeconds: number,
  sourceVersionId = 'v1'
): EditDecision {
  return {
    timelineStartSeconds: timelineStart,
    timelineEndSeconds: timelineStart + (outSeconds - inSeconds),
    inSeconds,
    outSeconds,
    sourceVersionId,
    cameraRole: 'A',
    targetTrack: 1,
  };
}

describe('deriveProgramTranscript', () => {
  it('keeps the words inside each edit, shifts them onto the timeline and splits at edit boundaries', () => {
    const transcripts = new Map([
      ['v1', { language: 'en', segments: [timed(0, 'one two three four five six')] }],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 2), edit(2, 4, 6)], transcripts);
    expect(result.language).toBe('en');
    expect(result.segments.map((segment) => segment.text)).toEqual(['one two', 'five six']);
    expect(result.segments[1]).toMatchObject({ startSec: 2, endSec: 3.8, speaker: null });
    expect(result.segments[1]!.words).toEqual([
      { start: 2, end: 2.8, text: 'five' },
      { start: 3, end: 3.8, text: 'six' },
    ]);
  });

  it('spreads an untimed segment over its range and keeps a word that mostly overlaps the edit', () => {
    const transcripts = new Map([
      [
        'v1',
        {
          language: 'it',
          segments: [
            { startSec: 0, endSec: 4, speaker: 'A', text: 'ciao a tutti quanti', words: [] },
          ],
        },
      ],
    ]);
    const result = deriveProgramTranscript([edit(0, 0.5, 4)], transcripts);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      text: 'ciao a tutti quanti',
      speaker: 'A',
      startSec: 0,
      endSec: 3.5,
    });
    expect(result.segments[0]!.words[0]).toEqual({ start: 0, end: 0.5, text: 'ciao' });
  });

  it('starts a new segment at a source segment boundary and when a segment grows too long', () => {
    const many = Array.from(
      { length: DERIVED_SEGMENT_MAX_WORDS + 2 },
      (_, index) => `w${index}`
    ).join(' ');
    const transcripts = new Map([
      [
        'v1',
        {
          language: 'en',
          segments: [timed(0, 'first line', 'A'), timed(2, 'second line', 'B'), timed(10, many)],
        },
      ],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 40)], transcripts);
    expect(result.segments.map((segment) => [segment.text, segment.speaker]).slice(0, 2)).toEqual([
      ['first line', 'A'],
      ['second line', 'B'],
    ]);
    expect(result.segments.slice(2).map((segment) => segment.words.length)).toEqual([
      DERIVED_SEGMENT_MAX_WORDS,
      2,
    ]);
  });

  it('follows the program order across clips and reads the language off the first transcript that has one', () => {
    const transcripts = new Map([
      ['a', { language: 'und', segments: [timed(0, 'from a')] }],
      ['b', { language: 'en', segments: [timed(0, 'from b')] }],
    ]);
    const result = deriveProgramTranscript([edit(0, 0, 2, 'b'), edit(2, 0, 2, 'a')], transcripts);
    expect(result.segments.map((segment) => segment.text)).toEqual(['from b', 'from a']);
    expect(result.language).toBe('en');
    expect(deriveProgramTranscript([], new Map())).toEqual({ language: 'und', segments: [] });
  });
});
```

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-vtt.test.ts tests/unit/lib/rough-cut-derived-transcript.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement vtt, caption-track and derived-transcript**

`lib/rough-cut/vtt.ts` (moved verbatim from the worker's private helpers so both sides share one serializer):

```ts
export type VttCue = { start: number; end: number; text: string };

export function toVttTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function serializeWebVtt(cues: VttCue[]): string {
  const body = cues
    .map((cue) => `${toVttTime(cue.start)} --> ${toVttTime(cue.end)}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}
```

`lib/rough-cut/caption-track.ts` (the worker's `upsertCaptionTrack`, with deps):

```ts
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type CaptionTrackDeps = {
  pool: Pool;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

/**
 * Store a WebVTT file for a version's language, replacing the track that was
 * there. Billed to the project owner, as the transcribe job does; the label
 * says the captions came from the transcript.
 */
export async function upsertCaptionTrack(
  deps: CaptionTrackDeps,
  options: { versionId: string; language: string; vtt: string }
): Promise<void> {
  const owner = await deps.pool.query(
    `SELECT p."ownerId" AS owner_id
     FROM video_versions vv
     JOIN videos v ON v.id = vv."videoParentId"
     JOIN projects p ON p.id = v."projectId"
     WHERE vv.id = $1`,
    [options.versionId]
  );
  const billedUserId = owner.rows[0]?.owner_id as string | undefined;
  if (!billedUserId) return;

  const filename = `${randomUUID()}.vtt`;
  const sourceUrl = `/api/upload/subtitle/${filename}`;
  const body = Buffer.from(options.vtt, 'utf8');
  await deps.uploadObject(`subtitles/${filename}`, body, 'text/vtt');

  const existing = await deps.pool.query(
    `SELECT id FROM video_subtitles WHERE "versionId" = $1 AND language = $2`,
    [options.versionId, options.language]
  );
  const label = `Transcript (${options.language})`;
  if (existing.rows[0]) {
    await deps.pool.query(
      `UPDATE video_subtitles
       SET "sourceUrl" = $2, size_bytes = $3, label = $4, "updatedAt" = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, sourceUrl, body.length, label]
    );
    return;
  }
  await deps.pool.query(
    `INSERT INTO video_subtitles
       (id, "versionId", language, label, "sourceUrl", size_bytes, "billedUserId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [options.versionId, options.language, label, sourceUrl, body.length, billedUserId]
  );
}
```

`lib/rough-cut/derived-transcript.ts`:

```ts
import type { Pool } from 'pg';
import { upsertCaptionTrack } from './caption-track';
import type { TimedWord } from './text';
import type { TranscriptSegmentRow } from './transcript-source';
import type { EditDecision } from './types';
import { serializeWebVtt } from './vtt';

/**
 * The transcript of a rendered program, derived from the source transcripts
 * through the decision list: every word inside an edit moves by the edit's
 * shift, nothing is transcribed again. Pure apart from `persistDerivedTranscript`.
 */

export type DerivedWord = TimedWord;

export type DerivedSegment = {
  startSec: number;
  endSec: number;
  speaker: string | null;
  text: string;
  words: DerivedWord[];
};

export type SourceTranscript = { language: string | null; segments: TranscriptSegmentRow[] };

export const DERIVED_TRANSCRIPT_PROVIDER = 'rough-cut';
export const DERIVED_SEGMENT_MAX_SECONDS = 8;
export const DERIVED_SEGMENT_MAX_WORDS = 18;
const EPSILON = 1e-6;

type SourceWord = TimedWord & { speaker: string | null; segmentIndex: number };

function isTimedWord(value: Partial<TimedWord>): value is TimedWord {
  return (
    typeof value.start === 'number' &&
    Number.isFinite(value.start) &&
    typeof value.end === 'number' &&
    Number.isFinite(value.end) &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0
  );
}

/** Timed words in source order; an untimed segment spreads its text evenly across its range. */
function flattenSource(segments: TranscriptSegmentRow[]): SourceWord[] {
  const out: SourceWord[] = [];
  segments.forEach((segment, segmentIndex) => {
    const speaker = segment.speaker && segment.speaker.trim() ? segment.speaker : null;
    const timed = Array.isArray(segment.words)
      ? (segment.words as Array<Partial<TimedWord>>).filter(isTimedWord)
      : [];
    if (timed.length > 0) {
      for (const word of timed) {
        out.push({
          start: word.start,
          end: Math.max(word.start, word.end),
          text: word.text.trim(),
          speaker,
          segmentIndex,
        });
      }
      return;
    }
    const tokens = segment.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || segment.endSec <= segment.startSec) return;
    const slice = (segment.endSec - segment.startSec) / tokens.length;
    tokens.forEach((text, index) => {
      out.push({
        start: segment.startSec + index * slice,
        end: index === tokens.length - 1 ? segment.endSec : segment.startSec + (index + 1) * slice,
        text,
        speaker,
        segmentIndex,
      });
    });
  });
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** A word belongs to an edit when at least half of it, or a full second of it, is inside. */
function wordInRange(word: TimedWord, inSeconds: number, outSeconds: number): boolean {
  const overlap = Math.min(word.end, outSeconds) - Math.max(word.start, inSeconds);
  if (overlap <= EPSILON) return false;
  const duration = Math.max(word.end - word.start, EPSILON);
  return overlap >= duration / 2 || overlap >= 1;
}

export function deriveProgramTranscript(
  edits: EditDecision[],
  transcripts: Map<string, SourceTranscript>
): { language: string; segments: DerivedSegment[] } {
  const wordsByVersion = new Map<string, SourceWord[]>();
  for (const [versionId, transcript] of transcripts) {
    wordsByVersion.set(versionId, flattenSource(transcript.segments));
  }

  type Open = DerivedSegment & { key: string };
  const segments: DerivedSegment[] = [];
  let current: Open | null = null;
  const close = () => {
    if (current && current.words.length > 0) {
      const { key: _key, ...segment } = current;
      void _key;
      segments.push(segment);
    }
    current = null;
  };

  const ordered = [...edits].sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds);
  ordered.forEach((edit, editIndex) => {
    const shift = edit.timelineStartSeconds - edit.inSeconds;
    for (const word of wordsByVersion.get(edit.sourceVersionId) ?? []) {
      if (!wordInRange(word, edit.inSeconds, edit.outSeconds)) continue;
      const start = Math.max(edit.timelineStartSeconds, word.start + shift);
      const end = Math.min(edit.timelineEndSeconds, Math.max(start, word.end + shift));
      const key = `${editIndex}:${word.segmentIndex}`;
      const overflow =
        current !== null &&
        (current.words.length >= DERIVED_SEGMENT_MAX_WORDS ||
          end - current.startSec > DERIVED_SEGMENT_MAX_SECONDS);
      if (current === null || current.key !== key || overflow) {
        close();
        current = { key, startSec: start, endSec: end, speaker: word.speaker, text: '', words: [] };
      }
      current.words.push({ start, end, text: word.text });
      current.endSec = Math.max(current.endSec, end);
      current.text = current.words.map((entry) => entry.text).join(' ');
    }
  });
  close();

  const languages = [...transcripts.values()].map((transcript) => transcript.language);
  const language = languages.find((entry) => entry && entry !== 'und') ?? languages[0] ?? 'und';
  return { language: language || 'und', segments };
}

export type DerivedTranscriptDeps = {
  pool: Pool;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

/** Write the derived transcript as the version's READY transcript and its caption track. */
export async function persistDerivedTranscript(
  deps: DerivedTranscriptDeps,
  options: { versionId: string; language: string; provider: string; segments: DerivedSegment[] }
): Promise<{ transcriptId: string }> {
  const searchText = options.segments.map((segment) => segment.text).join(' ');
  const upsert = await deps.pool.query(
    `INSERT INTO transcripts (id, version_id, language, provider, status, search_text, error, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'READY', $4, NULL, NOW(), NOW())
     ON CONFLICT (version_id, language)
     DO UPDATE SET provider = EXCLUDED.provider, status = 'READY', search_text = EXCLUDED.search_text, error = NULL,
       translation_language = NULL, translation_status = NULL, translation_error = NULL, translated_texts = NULL, updated_at = NOW()
     RETURNING id`,
    [options.versionId, options.language, options.provider, searchText]
  );
  const transcriptId = upsert.rows[0]?.id;
  if (typeof transcriptId !== 'string' || !transcriptId) {
    throw new Error('Could not store the derived transcript');
  }
  await deps.pool.query(`DELETE FROM transcript_segments WHERE transcript_id = $1`, [transcriptId]);
  for (let index = 0; index < options.segments.length; index += 1) {
    const segment = options.segments[index]!;
    await deps.pool.query(
      `INSERT INTO transcript_segments (id, transcript_id, start_sec, end_sec, speaker, text, words, position, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::jsonb, $7, NOW())`,
      [
        transcriptId,
        segment.startSec,
        segment.endSec,
        segment.speaker,
        segment.text,
        JSON.stringify(segment.words),
        index,
      ]
    );
  }
  await upsertCaptionTrack(deps, {
    versionId: options.versionId,
    language: options.language,
    vtt: serializeWebVtt(
      options.segments.map((segment) => ({
        start: segment.startSec,
        end: segment.endSec,
        text: segment.text,
      }))
    ),
  });
  return { transcriptId };
}
```

Run the two unit files. Expected: PASS.

- [ ] **Step 3: Failing test for the materialize job**

Create `tests/unit/lib/rough-cut-materialize-job.test.ts` with a fake pool in the style of `tests/unit/lib/rough-cut-assemble-job.test.ts`: record every `query(sql, params)`, answer `FROM rough_cuts` with a row `{ id: 'cut-1', project_id: 'proj-1', folder_id: null, decisions, overrides, output_video_id }`, `FROM video_versions WHERE id = ANY` with the source version rows, `FROM transcripts` with `[{ id: 't-a', version_id: 'ver-a', language: 'en' }]`, `FROM transcript_segments` with one timed segment `'one two three four five six'` at 0–6 (words 1 s apart, 0.8 s long), `COALESCE(MAX("versionNumber")` with `{ max: 1 }`, `SELECT id FROM videos` with `[{ id: 'out-1' }]`, `SELECT position FROM videos` with `[]`, `INSERT INTO transcripts` with `[{ id: 't-out' }]`, `SELECT p."ownerId"` with `[{ owner_id: 'owner-1' }]`, and `{ rows: [] }` otherwise. `run` records args and returns `{ code: 0 }`; `downloadObject` records keys; `uploadObject` records `{ key, contentType }`; use `vi.mock('node:fs/promises', ...)` only if needed for `readFile` of the ffmpeg output — simpler: pass `readOutput: async () => Buffer.from('mp4')` as a dep (see the deps type below) so the test never touches the filesystem beyond `mkdtemp`.

Tests:

1. `renders the effective program and writes a derived transcript and caption track for the new version`: decisions = two edits (in 1–4, 6–10 of `ver-a`), one island 4–6, `overrides = { version: 1, cuts: { [key]: 'restore' }, extraCuts: [] }`, `output_video_id = 'out-1'`. Assert: ffmpeg was run once and the `-ss`/`-t` pairs are `['1.000','9.000']` (restored island merged the two edits); the `UPDATE video_versions SET "isActive" = false` query targets `out-1`; the `INSERT INTO video_versions` params contain `versionNumber 2` and a label starting with `Re-render`; `UPDATE rough_cuts` params include `output_video_id = 'out-1'` and a `rendered_decisions` JSON whose `edits` equal the effective program; `INSERT INTO transcripts` params are `[<new version id>, 'en', 'rough-cut', 'one two three four five six']`; six `INSERT INTO transcript_segments`? no: one segment (one source segment, 6 words) whose words are shifted by −1 (`start` 0..5); one `uploadObject` with key starting `subtitles/` and `text/vtt`; a `PROBE_MEDIA` media job insert for the new version.
2. `creates the output video on a first render`: `output_video_id = null`, no overrides → `INSERT INTO videos` once, version 1, `rendered_overrides` param `null`.
3. `refuses a program that the reviewer cut to nothing`: overrides with an extra cut spanning the whole clip → the job throws `/Nothing is left/` and runs no ffmpeg.

- [ ] **Step 4: Implement the job in lib and re-export from the worker**

Create `lib/rough-cut/materialize-job.ts` by moving `worker/src/materialize-rough-cut.ts` and changing it as follows (relative imports only):

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { parseRoughCutDecisionList } from './decision-list';
import {
  DERIVED_TRANSCRIPT_PROVIDER,
  deriveProgramTranscript,
  persistDerivedTranscript,
  type SourceTranscript,
} from './derived-transcript';
import { materializeFfmpegArgs } from './materialize';
import { applyOverrides, parseRoughCutOverrides } from './overrides';
import type { RoughCutDecisionList } from './types';

export type MaterializeDeps = {
  pool: Pool;
  run: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  downloadObject: (key: string, dest: string) => Promise<void>;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  objectKeyFromProvider: (version: {
    providerId: string;
    videoId: string;
    originalUrl: string;
  }) => string | null;
  /** Reads the encoded file back; a test can hand in bytes without a filesystem. */
  readOutput?: (path: string) => Promise<Buffer>;
};
```

Body changes relative to the worker version:

- Select `overrides, output_video_id` too; `const overrides = parseRoughCutOverrides(cut.overrides); const effective = applyOverrides(decisions, overrides); if (effective.edits.length === 0) throw new Error('Nothing is left in the program after the reviewer’s cuts');` and use `effective.edits` for the segments/versions.
- After the upload, replace the video/version creation with `const output = await createOutputVersion(deps, { projectId, folderId, existingVideoId: cut.output_video_id, objectKey, originalUrl, sizeBytes })` where:

```ts
async function createOutputVersion(deps, options): Promise<{ videoId: string; versionId: string }> {
  const existing = options.existingVideoId
    ? await deps.pool.query(`SELECT id FROM videos WHERE id = $1`, [options.existingVideoId])
    : null;
  const versionRowId = randomUUID();
  if (existing?.rows[0]) {
    const videoId = String(existing.rows[0].id);
    const max = await deps.pool.query(
      `SELECT COALESCE(MAX("versionNumber"), 0) AS max FROM video_versions WHERE "videoParentId" = $1`,
      [videoId]
    );
    const next = Number(max.rows[0]?.max ?? 0) + 1;
    await deps.pool.query(
      `UPDATE video_versions SET "isActive" = false WHERE "videoParentId" = $1`,
      [videoId]
    );
    await deps.pool.query(
      `INSERT INTO video_versions (id, "versionNumber", "versionLabel", "providerId", "videoId", "originalUrl", title, "thumbnailUrl", size_bytes, "isActive", "videoParentId", "createdAt", proxy_status)
       VALUES ($1, $2, $3, 'r2', $4, $5, $6, '/placeholder-video-thumbnail.png', $7, true, $8, NOW(), 'SKIPPED')`,
      [
        versionRowId,
        next,
        `Re-render ${next - 1}`,
        options.objectKey,
        options.originalUrl,
        `Rough cut v${next}`,
        options.sizeBytes,
        videoId,
      ]
    );
    return { videoId, versionId: versionRowId };
  }
  // First render: the existing video + version-1 insert, unchanged, then return ids.
}
```

- Then: `await deps.pool.query(`UPDATE rough_cuts SET output_video_id = $2, rendered_overrides = $3::jsonb, rendered_decisions = $4::jsonb, updated_at = NOW() WHERE id = $1`, [roughCutId, output.videoId, overrides ? JSON.stringify(overrides) : null, JSON.stringify(effective)]);`
- Then the derived transcript, never fatal:

```ts
try {
  await writeDerivedTranscript(deps, effective, output.versionId);
} catch (error) {
  console.error(`derived transcript failed for rough cut ${roughCutId}`, error);
}
```

with

```ts
async function writeDerivedTranscript(
  deps: MaterializeDeps,
  effective: RoughCutDecisionList,
  versionId: string
): Promise<void> {
  const versionIds = [...new Set(effective.edits.map((edit) => edit.sourceVersionId))];
  const rows = await deps.pool.query(
    `SELECT DISTINCT ON (version_id) id, version_id, language
     FROM transcripts WHERE version_id = ANY($1::text[]) AND status = 'READY'
     ORDER BY version_id, created_at ASC`,
    [versionIds]
  );
  const transcripts = new Map<string, SourceTranscript>();
  for (const row of rows.rows) {
    const segments = await deps.pool.query(
      `SELECT start_sec, end_sec, speaker, text, words FROM transcript_segments WHERE transcript_id = $1 ORDER BY position ASC`,
      [row.id]
    );
    transcripts.set(String(row.version_id), {
      language: typeof row.language === 'string' ? row.language : null,
      segments: segments.rows.map((segment) => ({
        startSec: Number(segment.start_sec),
        endSec: Number(segment.end_sec),
        speaker:
          typeof segment.speaker === 'string' && segment.speaker.trim() ? segment.speaker : null,
        text: typeof segment.text === 'string' ? segment.text : '',
        words: segment.words,
      })),
    });
  }
  if (transcripts.size === 0) return;
  const derived = deriveProgramTranscript(effective.edits, transcripts);
  if (derived.segments.length === 0) return;
  await persistDerivedTranscript(deps, {
    versionId,
    language: derived.language,
    provider: DERIVED_TRANSCRIPT_PROVIDER,
    segments: derived.segments,
  });
}
```

- Finally the `PROBE_MEDIA` insert for `output.versionId` as before. Use `const body = await (deps.readOutput ?? readFile)(output)`.

`worker/src/materialize-rough-cut.ts` becomes a re-export like `assemble-rough-cut.ts`:

```ts
export { materializeRoughCut } from '../lib/rough-cut/materialize-job';
export type { MaterializeDeps } from '../lib/rough-cut/materialize-job';
```

`worker/src/index.ts`: delete its private `toVttTime`, `serializeWebVtt` and `upsertCaptionTrack`; import `serializeWebVtt` from `../lib/rough-cut/vtt` and `upsertCaptionTrack` from `../lib/rough-cut/caption-track`, calling it as `upsertCaptionTrack({ pool, uploadObject }, { versionId, language: detected, vtt: serializeWebVtt(result.segments) })`.

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-materialize-job.test.ts`
Expected: PASS. Then `bun run test` and `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add lib worker tests
git commit -m "feat(rough-cut): derive the output transcript and captions from the decision list; version re-renders

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Cut review pane on the output video

**Files:**

- Create: `components/video-page/hooks/use-rough-cut-review.ts`
- Create: `components/video-page/rough-cut-review-pane.tsx`
- Modify: `components/video-page/comments-pane.tsx` (third pane tab)
- Modify: `components/video-page-content.tsx` (state, hook, pane)
- Modify: `components/video-page/hooks/use-video-page-data.ts` (`reloadVideo`)
- Test: `tests/component/hooks/use-rough-cut-review.test.ts`

Context: on the output video the operator wants to see what was removed and why, look at the uncut source next to the cut, and restore or add cuts without leaving the page. The pane lives in the right-hand side panel next to Comments and Assets (only on rough-cut outputs), shows a source player that can follow the output playhead, lists every cut island with its reason and transcript, and offers Restore / Keep, an extra cut from the output's current time, Save, and Re-render (a new version of this video, Task 6).

- [ ] **Step 1: Failing hook test**

Create `tests/component/hooks/use-rough-cut-review.test.ts` in the style of `tests/component/hooks/use-subtitles.test.ts` (stub `fetch`, `renderHook`, `waitFor`, `act`). Build a `review` payload matching Task 5's `GET /api/videos/[videoId]/rough-cut` response: one source clip `ver-a` (offset 0, duration 30, playbackUrl `/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4`), decisions with edits `[0–3 from 1–4], [3–7 from 6–10]` and one island `key: 'ver-a:96-144'` (24 fps, 4–6 s, DEAD_AIR), `overrides: null`, `renderedOverrides: null`, `needsRender: false`, `render: { status: 'idle', error: null, updatedAt: null }`, `canEdit: true`.

Tests:

1. `loads the review for a rough-cut output and reports none for other videos`: after mount `result.current.review` equals the payload's review and `result.current.roughCut.id` is set; with `{ data: { roughCut: null } }` → `review` is null and `isRoughCutOutput` is false.
2. `tracks pending decisions locally and saves them with PUT`: `act(() => result.current.setCutAction('ver-a:96-144', 'restore'))` → `result.current.draft.cuts` equals `{ 'ver-a:96-144': 'restore' }` and `isDirty` is true; `await act(() => result.current.save())` → a `PUT /api/rough-cuts/cut-1/overrides` call whose JSON body is `{ version: 1, cuts: { 'ver-a:96-144': 'restore' }, extraCuts: [] }`; with the PUT answering `{ data: { overrides, summary, needsRender: true } }`, `isDirty` becomes false and `needsRender` true.
3. `maps an output time range to source ranges through the effective program`: `result.current.sourceRangesForTimeline(2, 4)` returns `[{ sourceVersionId: 'ver-a', inSeconds: 3, outSeconds: 4 }, { sourceVersionId: 'ver-a', inSeconds: 6, outSeconds: 7 }]`; `result.current.sourceTimeAt(5)` returns `{ sourceVersionId: 'ver-a', seconds: 8 }`; `sourceTimeAt(99)` returns null.
4. `adds an extra cut from a timeline range and removes it again`: `act(() => result.current.addExtraCutFromTimeline(2, 4, 'boring'))` → `draft.extraCuts` has two entries with `note: 'boring'`; `act(() => result.current.removeExtraCut(draft.extraCuts[0].key))` leaves one.
5. `starts a render and polls until the job leaves the queue, then calls onRendered`: `await act(() => result.current.render())` → `POST /api/rough-cuts/cut-1/render`; with fake timers, the hook re-fetches the review every 4 s while `render.status` is `queued`/`running`; when a fetch answers `status: 'idle'` and a changed `renderedOverrides`, `onRendered` has been called once and polling stops.

Run: `bun run vitest run --project component tests/component/hooks/use-rough-cut-review.test.ts`
Expected: FAIL.

- [ ] **Step 2: The hook**

Create `components/video-page/hooks/use-rough-cut-review.ts`:

```ts
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyOverrides,
  emptyOverrides,
  extraCutKey,
  overridesEqual,
  type CutOverrideAction,
  type ExtraCut,
  type RoughCutOverrides,
} from '@/lib/rough-cut/overrides';
import type { RoughCutReview, RoughCutReviewSource } from '@/lib/rough-cut/review';
import type { RoughCutDecisionList } from '@/lib/rough-cut/types';
import type { RoughCutRecord } from '@/components/video-page/hooks/use-rough-cut';

export const ROUGH_CUT_REVIEW_POLL_MS = 4000;

type ReviewPayload = {
  roughCut: RoughCutRecord | null;
  review: RoughCutReview | null;
  canEdit?: boolean;
};

export type SourceRange = { sourceVersionId: string; inSeconds: number; outSeconds: number };

function readClientApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

/** The edit under a timeline second, or null between programs. */
function editAt(decisions: RoughCutDecisionList, seconds: number) {
  return (
    decisions.edits.find(
      (edit) => seconds >= edit.timelineStartSeconds && seconds < edit.timelineEndSeconds
    ) ?? null
  );
}

export function useRoughCutReview(options: {
  videoId: string;
  enabled: boolean;
  onRendered?: () => void;
}) {
  const { videoId, enabled, onRendered } = options;
  const [roughCut, setRoughCut] = useState<RoughCutRecord | null>(null);
  const [review, setReview] = useState<RoughCutReview | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [draft, setDraft] = useState<RoughCutOverrides>(emptyOverrides());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const lastRenderedRef = useRef<string>('');

  const load = useCallback(async (): Promise<ReviewPayload | null> => {
    const response = await fetch(`/api/videos/${videoId}/rough-cut`, { cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(readClientApiError(payload, 'Failed to load the rough cut'));
      return null;
    }
    const data = (payload as { data?: ReviewPayload }).data ?? null;
    setRoughCut(data?.roughCut ?? null);
    setReview(data?.review ?? null);
    setCanEdit(Boolean(data?.canEdit));
    return data;
  }, [videoId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    void load()
      .then((data) => {
        if (cancelled || !data?.review) return;
        setDraft(data.review.overrides ?? emptyOverrides());
        lastRenderedRef.current = JSON.stringify(data.review.renderedOverrides ?? null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, load]);

  // A render in flight: poll until the job is gone, then tell the page the
  // video grew a version.
  const renderStatus = review?.render.status ?? 'idle';
  useEffect(() => {
    if (!enabled || (renderStatus !== 'queued' && renderStatus !== 'running')) return;
    const timer = window.setInterval(() => {
      void load().then((data) => {
        if (!data?.review) return;
        const status = data.review.render.status;
        if (status === 'queued' || status === 'running') return;
        const rendered = JSON.stringify(data.review.renderedOverrides ?? null);
        if (status === 'idle' && rendered !== lastRenderedRef.current) {
          lastRenderedRef.current = rendered;
          onRenderedRef.current?.();
        }
      });
    }, ROUGH_CUT_REVIEW_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, load, renderStatus]);

  const effective = useMemo(
    () => (review ? applyOverrides(review.decisions, draft) : null),
    [review, draft]
  );
  const rendered = review?.renderedDecisions ?? review?.decisions ?? null;

  const setCutAction = useCallback((key: string, action: CutOverrideAction | null) => {
    setDraft((current) => {
      const cuts = { ...current.cuts };
      if (action) cuts[key] = action;
      else delete cuts[key];
      return { ...current, cuts };
    });
  }, []);

  /** Source time under an output second, mapped through what is currently rendered. */
  const sourceTimeAt = useCallback(
    (seconds: number): { sourceVersionId: string; seconds: number } | null => {
      if (!rendered) return null;
      const edit = editAt(rendered, seconds);
      if (!edit) return null;
      return {
        sourceVersionId: edit.sourceVersionId,
        seconds: edit.inSeconds + (seconds - edit.timelineStartSeconds),
      };
    },
    [rendered]
  );

  /** Source ranges under an output range, one per edit it crosses. */
  const sourceRangesForTimeline = useCallback(
    (start: number, end: number): SourceRange[] => {
      if (!rendered || end <= start) return [];
      const ranges: SourceRange[] = [];
      for (const edit of rendered.edits) {
        const from = Math.max(start, edit.timelineStartSeconds);
        const to = Math.min(end, edit.timelineEndSeconds);
        if (to - from <= 1e-6) continue;
        ranges.push({
          sourceVersionId: edit.sourceVersionId,
          inSeconds: edit.inSeconds + (from - edit.timelineStartSeconds),
          outSeconds: edit.inSeconds + (to - edit.timelineStartSeconds),
        });
      }
      return ranges;
    },
    [rendered]
  );

  const addExtraCutFromTimeline = useCallback(
    (start: number, end: number, note: string | null) => {
      if (!review) return;
      const rate = review.decisions.rate;
      const additions: ExtraCut[] = sourceRangesForTimeline(start, end).map((range) => ({
        key: extraCutKey(range.sourceVersionId, range.inSeconds, range.outSeconds, rate),
        ...range,
        note: note && note.trim() ? note.trim() : null,
      }));
      setDraft((current) => {
        const seen = new Set(current.extraCuts.map((cut) => cut.key));
        return {
          ...current,
          extraCuts: [...current.extraCuts, ...additions.filter((cut) => !seen.has(cut.key))],
        };
      });
    },
    [review, sourceRangesForTimeline]
  );

  const removeExtraCut = useCallback((key: string) => {
    setDraft((current) => ({
      ...current,
      extraCuts: current.extraCuts.filter((cut) => cut.key !== key),
    }));
  }, []);

  const save = useCallback(async (): Promise<string | null> => {
    if (!roughCut) return 'No rough cut';
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/rough-cuts/${roughCut.id}/overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = readClientApiError(payload, 'Failed to save changes');
        setError(message);
        return message;
      }
      const data = (payload as { data?: { overrides: RoughCutOverrides; needsRender: boolean } })
        .data;
      if (data) {
        setDraft(data.overrides);
        setReview((current) =>
          current
            ? { ...current, overrides: data.overrides, needsRender: data.needsRender }
            : current
        );
      }
      return null;
    } catch {
      setError('Failed to save changes');
      return 'Failed to save changes';
    } finally {
      setSaving(false);
    }
  }, [draft, roughCut]);

  const render = useCallback(async (): Promise<string | null> => {
    if (!roughCut) return 'No rough cut';
    setRendering(true);
    setError(null);
    try {
      const response = await fetch(`/api/rough-cuts/${roughCut.id}/render`, { method: 'POST' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = readClientApiError(payload, 'Failed to start the render');
        setError(message);
        return message;
      }
      setReview((current) =>
        current
          ? { ...current, render: { status: 'queued', error: null, updatedAt: null } }
          : current
      );
      return null;
    } catch {
      setError('Failed to start the render');
      return 'Failed to start the render';
    } finally {
      setRendering(false);
    }
  }, [roughCut]);

  const isDirty = !overridesEqual(draft, review?.overrides ?? null);
  const needsRender = Boolean(
    review && !overridesEqual(review.overrides, review.renderedOverrides)
  );
  const sources: RoughCutReviewSource[] = review?.sources ?? [];

  return {
    roughCut,
    review,
    canEdit,
    draft,
    effective,
    sources,
    loading,
    saving,
    rendering,
    error,
    isRoughCutOutput: Boolean(review),
    isDirty,
    needsRender,
    renderStatus,
    setCutAction,
    addExtraCutFromTimeline,
    removeExtraCut,
    sourceTimeAt,
    sourceRangesForTimeline,
    save,
    render,
    reload: load,
  };
}
```

Run the hook test. Expected: PASS.

- [ ] **Step 3: The pane**

Create `components/video-page/rough-cut-review-pane.tsx` (client component; uses `Button` from `@/components/ui/button`, `Badge`, `Textarea`, `Input`, `cn`, lucide icons `RotateCcw`, `Scissors`, `Play`, `Loader2`, `Check`, `Trash2`). Props:

```ts
interface RoughCutReviewPaneProps {
  review: ReturnType<typeof useRoughCutReview>;
  /** Output player time, read on demand. */
  getCurrentTime: () => number;
  onSeekOutput: (seconds: number) => void;
}
```

Layout, top to bottom:

1. **Summary line**: `{n} cuts · {dead air}/{false starts}/{rejected takes}`, program length before → after (from `overrideSummary(review.review.decisions, review.draft)`), and warnings from `review.roughCut.warnings` (amber list, max 5, as the dialog does).
2. **Source preview**: a `<select>` of `review.sources` when more than one (label `title · role`), a `<video controls playsInline preload="metadata">` whose `src` is the selected source's `playbackUrl` when `playbackKind === 'file'`; for `hls` use `hls.js` the way `player-core.tsx` does (import `Hls`, attach on mount when `Hls.isSupported()`, else set `src`). A "Follow output" checkbox: while checked, a `requestAnimationFrame` loop reads `getCurrentTime()`, calls `review.sourceTimeAt(t)`, switches the selected source when the version changes, and seeks the source video (paused) when it drifts more than 0.5 s; the loop stops when unchecked or on unmount.
3. **Cut a range from the output**: two `Input type="number"` fields (start/end seconds) prefilled from `getCurrentTime()` via "Use current time" buttons, a note `Input` (max 300), and an "Add cut" button → `review.addExtraCutFromTimeline(start, end, note)`. Below it the draft's extra cuts, each with source time range, note and a remove button.
4. **Cut list**: `review.review.decisions.cuts` sorted by `(offset + inSeconds)`, each row: reason badge (`Dead air` / `False start` / `Rejected take`), `formatClock(inSeconds)–formatClock(outSeconds)` with duration, `transcriptText` (line-clamp-2), buttons `Play source` (select that clip, seek the source video to `inSeconds`, play, pause at `outSeconds` via a `timeupdate` listener), `Restore` (toggles `review.setCutAction(key, current === 'restore' ? null : 'restore')`) and `Keep` (same for `'keep'`), with the active choice rendered as `variant="default"`. A restored island whose position is inside the rendered program also gets an "Output" button that seeks the output player to the island's timeline position when it exists in `review.effective` (find the edit whose source range contains `inSeconds`).
5. **Footer**: `Save changes` (disabled unless `isDirty`, spinner while saving), `Re-render` (disabled unless `needsRender && !isDirty` and `renderStatus` is `idle`/`failed`), and a status line: `Rendering… a new version appears here when it is done` for queued/running, the job error for failed, `Changes saved but not rendered yet` when `needsRender`. Errors from the hook render in `text-destructive`. When `!review.canEdit`, hide the action buttons and show the list read-only.

`formatClock` is a local helper (`m:ss`). Presentation only: no component test beyond the hook test.

- [ ] **Step 4: Wire the pane into the page**

`components/video-page/hooks/use-video-page-data.ts`: turn the inline `fetchVideo` into a `useCallback` named `loadVideo` (same body, dependencies `[apiBasePath, mode]`), call it from the effect, and return it as `reloadVideo`.

`components/video-page/comments-pane.tsx`: the pane already switches between `comments` and `assets` through `activePane`/`setActivePane` and renders `assetsPane`. Extend the type to `'comments' | 'assets' | 'cuts'`, add optional props `cutsPane?: ReactNode` and `showCutsTab?: boolean`, add a third tab button labelled `Cuts` (same styling as the Assets tab) rendered only when `showCutsTab`, and render `cutsPane` when `activePane === 'cuts'`. Read the file to find the tab strip; mirror the Assets tab exactly.

`components/video-page-content.tsx`:

- `useState<'comments' | 'assets' | 'cuts'>('comments')` for `activeSidePane`.
- After `useVideoPageData(...)` destructuring add `reloadVideo` to it, and:

```tsx
const roughCutReview = useRoughCutReview({
  videoId,
  enabled: !loading && !!video && (video.kind ?? 'VIDEO') === 'VIDEO',
  onRendered: () => void reloadVideo(),
});
```

- Pass to `CommentsPane`: `showCutsTab={roughCutReview.isRoughCutOutput}` and `cutsPane={<RoughCutReviewPane review={roughCutReview} getCurrentTime={getCurrentTime} onSeekOutput={handleSeekToTimestamp} />}` (`getCurrentTime` and `handleSeekToTimestamp` already exist in the page).
- When `roughCutReview.isRoughCutOutput` first becomes true and the side pane is still `comments`, do not auto-switch; the tab is enough.

Run `bun run test` and `bun run check`. There is no dev server to screenshot; the hook test plus typecheck are the gate.

- [ ] **Step 5: Commit**

```bash
git add components tests
git commit -m "feat(review): cut review pane with source preview, restore/keep, extra cuts and re-render

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Fix words in the transcript; captions from the transcript without re-transcribing

**Files:**

- Create: `lib/transcript-edit.ts`
- Create: `lib/transcript-caption.ts` (extracted from the upload route)
- Modify: `app/api/versions/[versionId]/transcript/upload/route.ts` (use `lib/transcript-caption.ts`)
- Create: `app/api/versions/[versionId]/transcript/segments/[segmentId]/route.ts`
- Create: `app/api/versions/[versionId]/transcript/captions/route.ts`
- Create: `components/video-page/hooks/use-transcript-segment-edit.ts`
- Modify: `components/video-page/transcript-pane.tsx` (edit dialog)
- Modify: `components/video-page/hooks/use-subtitles.ts` (`generateSubtitles` reuses a READY transcript)
- Modify: `components/video-page/subtitle-controls.tsx` (dialog copy)
- Modify: `tests/api/auth-matrix.test.ts`
- Test: `tests/unit/lib/transcript-edit.test.ts`, `tests/api/transcript-edit.test.ts`, `tests/component/hooks/use-transcript-segment-edit.test.ts`, `tests/component/hooks/use-subtitles.test.ts`

Context: a transcript line with a misheard word is corrected in place. The words keep their timings when the count is unchanged; otherwise the new words are spread evenly across the segment (the same rule uploaded SRTs use). The caption track for the transcript's language is rebuilt from the transcript after every edit, so subtitles and transcript never diverge. "Generate AI" on a version that already has a READY transcript builds the captions from it instead of transcribing again.

- [ ] **Step 1: Failing unit test for retiming**

Create `tests/unit/lib/transcript-edit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseSegmentPatch, retimeSegmentWords } from '@/lib/transcript-edit';

describe('retimeSegmentWords', () => {
  const words = [
    { start: 1, end: 1.4, text: 'we' },
    { start: 1.5, end: 1.9, text: 'held' },
    { start: 2, end: 2.6, text: 'founders' },
  ];

  it('keeps the timings when the word count is unchanged', () => {
    expect(retimeSegmentWords(words, 'we help founders', 1, 3)).toEqual([
      { start: 1, end: 1.4, text: 'we' },
      { start: 1.5, end: 1.9, text: 'help' },
      { start: 2, end: 2.6, text: 'founders' },
    ]);
  });

  it('spreads the words across the segment when the count changes', () => {
    expect(retimeSegmentWords(words, 'we help all founders', 1, 3)).toEqual([
      { start: 1, end: 1.5, text: 'we' },
      { start: 1.5, end: 2, text: 'help' },
      { start: 2, end: 2.5, text: 'all' },
      { start: 2.5, end: 3, text: 'founders' },
    ]);
  });

  it('spreads when the stored words are not timed', () => {
    expect(retimeSegmentWords([], 'hello there', 0, 1)).toEqual([
      { start: 0, end: 0.5, text: 'hello' },
      { start: 0.5, end: 1, text: 'there' },
    ]);
    expect(retimeSegmentWords('garbage', 'hello', 0, 0)).toEqual([]);
  });
});

describe('parseSegmentPatch', () => {
  it('accepts text and an optional speaker and refuses blanks and oversize', () => {
    expect(parseSegmentPatch({ text: '  Hello  ' })).toEqual({
      ok: true,
      value: { text: 'Hello', speaker: undefined },
    });
    expect(parseSegmentPatch({ text: 'Hi', speaker: null })).toEqual({
      ok: true,
      value: { text: 'Hi', speaker: null },
    });
    expect(parseSegmentPatch({ text: '   ' }).ok).toBe(false);
    expect(parseSegmentPatch({ text: 'x'.repeat(2001) }).ok).toBe(false);
    expect(parseSegmentPatch({ text: 'Hi', speaker: 'x'.repeat(81) }).ok).toBe(false);
    expect(parseSegmentPatch({}).ok).toBe(false);
  });
});
```

Run: `bun run vitest run --project unit tests/unit/lib/transcript-edit.test.ts` → FAIL.

- [ ] **Step 2: Implement `lib/transcript-edit.ts` and `lib/transcript-caption.ts`**

`lib/transcript-edit.ts`:

```ts
import { z } from 'zod';
import { splitWords, spreadWordsAcrossRange } from '@/lib/transcript-import';
import type { TranscriptWord } from '@/lib/transcription/types';

export const MAX_SEGMENT_TEXT = 2000;
export const MAX_SPEAKER_LABEL = 80;

const patchSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_SEGMENT_TEXT),
    speaker: z.string().trim().max(MAX_SPEAKER_LABEL).nullable().optional(),
  })
  .strict();

export type SegmentPatch = z.infer<typeof patchSchema>;

export function parseSegmentPatch(
  input: unknown
): { ok: true; value: SegmentPatch } | { ok: false; error: string } {
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid segment',
    };
  }
  return { ok: true, value: parsed.data };
}

function timedWords(value: unknown): TranscriptWord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (word): word is TranscriptWord =>
      typeof word === 'object' &&
      word !== null &&
      typeof (word as TranscriptWord).start === 'number' &&
      typeof (word as TranscriptWord).end === 'number' &&
      typeof (word as TranscriptWord).text === 'string'
  );
}

/**
 * New words for an edited segment. When the count matches the stored timed
 * words, each keeps its timing (a misheard word fixed in place); otherwise
 * the words are spread evenly across the segment, as an uploaded SRT is.
 */
export function retimeSegmentWords(
  previousWords: unknown,
  text: string,
  startSec: number,
  endSec: number
): TranscriptWord[] {
  const next = splitWords(text);
  const previous = timedWords(previousWords);
  if (previous.length > 0 && previous.length === next.length) {
    return previous.map((word, index) => ({
      start: word.start,
      end: word.end,
      text: next[index]!,
    }));
  }
  return spreadWordsAcrossRange(next, startSec, endSec);
}
```

`lib/transcript-caption.ts`: move `upsertCaptionTrack` out of `app/api/versions/[versionId]/transcript/upload/route.ts` as:

```ts
export type CaptionSegment = { startSec: number; endSec: number; text: string };

/**
 * Rebuild the caption track of a version's language from transcript
 * segments. Returns 'skipped' when the version already holds the maximum
 * number of tracks and none is in this language.
 */
export async function syncCaptionTrackFromSegments(input: {
  versionId: string;
  language: string;
  segments: CaptionSegment[];
  billedUserId: string;
  uploadedByUserId: string | null;
}): Promise<'updated' | 'skipped'>;
```

with the same body (VTT via `serializeWebVtt`, quota reservation, R2 put, transaction replacing the row, stale object delete, `'storage-quota'` error thrown when the reservation fails). The upload route imports it and passes `imported.segments` mapped to `{ startSec, endSec, text }`. Add a second helper:

```ts
/** The same, from the transcript rows themselves. Returns 'empty' when the transcript has no timed segment. */
export async function syncCaptionTrackFromTranscript(input: {
  transcriptId: string;
  billedUserId: string;
  uploadedByUserId: string | null;
}): Promise<'updated' | 'skipped' | 'empty'>;
```

which loads the transcript (`versionId`, `language`, segments ordered by position), keeps segments with `endSec > startSec`, and calls the first helper.

Run the unit test → PASS.

- [ ] **Step 3: Failing API tests**

Create `tests/api/transcript-edit.test.ts` with the R2 recorder mock from `tests/api/transcript.test.ts` (copy the `vi.hoisted` + `vi.mock('@/lib/r2', ...)` block). Cases:

1. `PATCH .../segments/[segmentId]`: 401 anonymous (row unchanged), 403 for a project VIEWER, 404 for a segment that belongs to another version, 400 for blank text, and the happy path for the owner: seed a READY transcript (`createReadyTranscript` with one segment `startSec 1, endSec 3, text 'we held founders'` then set its `words` to three timed words via `db.transcriptSegment.update`), PATCH `{ text: 'we help founders', speaker: 'Tom' }` → 200; the row's `text`, `speaker` and `words` (timings kept, middle word `help`) are updated; the transcript's `searchText` is `we help founders`; one `PutObjectCommand` was recorded under `subtitles/` with a body containing `we help founders`; a `video_subtitles` row exists for `(versionId, 'en')`.
2. `POST .../transcript/captions`: 401/403; 400 when the version has no READY transcript; happy path: READY transcript with a timed segment → 201 with `{ subtitle: { language: 'en', url: '/api/upload/subtitle/…' } }`, a `video_subtitles` row, one R2 put; and no `TRANSCRIBE` media job created.

Add both routes to `tests/api/auth-matrix.test.ts` (fixture needs a `segmentId`: create a READY transcript with one segment in `seedFixtures` and expose `segmentId`; PATCH body `{ text: 'Hello' }`).

Run the api file + auth-matrix → FAIL.

- [ ] **Step 4: Routes**

`app/api/versions/[versionId]/transcript/segments/[segmentId]/route.ts`:

```ts
import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { syncCaptionTrackFromTranscript } from '@/lib/transcript-caption';
import { parseSegmentPatch, retimeSegmentWords } from '@/lib/transcript-edit';

type RouteParams = { params: Promise<{ versionId: string; segmentId: string }> };

// PATCH /api/versions/[versionId]/transcript/segments/[segmentId] — fix the words of one line; captions follow.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { versionId, segmentId } = await params;
    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: {
              select: {
                id: true,
                ownerId: true,
                workspaceId: true,
                visibility: true,
                workspace: { select: { ownerId: true } },
              },
            },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');
    const access = await checkProjectAccess(version.video.project, session.user.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const segment = await db.transcriptSegment.findFirst({
      where: { id: segmentId, transcript: { versionId } },
      include: { transcript: { select: { id: true } } },
    });
    if (!segment) return apiErrors.notFound('Transcript segment');

    const body = await request.json().catch(() => null);
    const parsed = parseSegmentPatch(body);
    if (!parsed.ok) return apiErrors.badRequest(parsed.error);

    const words = retimeSegmentWords(
      segment.words,
      parsed.value.text,
      segment.startSec,
      segment.endSec
    );
    const updated = await db.$transaction(async (tx) => {
      const row = await tx.transcriptSegment.update({
        where: { id: segment.id },
        data: {
          text: parsed.value.text,
          words: words as unknown as Prisma.InputJsonValue,
          ...(parsed.value.speaker === undefined ? {} : { speaker: parsed.value.speaker || null }),
        },
      });
      const siblings = await tx.transcriptSegment.findMany({
        where: { transcriptId: segment.transcript.id },
        orderBy: { position: 'asc' },
        select: { text: true },
      });
      await tx.transcript.update({
        where: { id: segment.transcript.id },
        data: { searchText: siblings.map((entry) => entry.text).join(' ') },
      });
      return row;
    });

    let captions: 'updated' | 'skipped' | 'empty' | 'failed' = 'failed';
    try {
      captions = await syncCaptionTrackFromTranscript({
        transcriptId: segment.transcript.id,
        billedUserId: version.video.project.workspace.ownerId,
        uploadedByUserId: session.user.id,
      });
    } catch (captionError) {
      logError('Failed to rebuild captions after a transcript edit:', captionError);
    }

    return withCacheControl(
      successResponse({
        segment: {
          id: updated.id,
          startSec: updated.startSec,
          endSec: updated.endSec,
          speaker: updated.speaker,
          text: updated.text,
          words: updated.words,
          position: updated.position,
        },
        captions,
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error editing transcript segment:', error);
    return apiErrors.internalError('Failed to edit the transcript');
  }
}
```

`app/api/versions/[versionId]/transcript/captions/route.ts` (`POST`): same auth as above; find the version's oldest READY transcript (`db.transcript.findFirst({ where: { versionId, status: 'READY' }, orderBy: { createdAt: 'asc' } })`, 400 `'This version has no transcript yet'` when none); call `syncCaptionTrackFromTranscript`; `'empty'` → 400 `'The transcript has no timed lines to caption'`, `'skipped'` → 400 `'This version already holds the maximum number of subtitle tracks'`; on `'updated'` load the `videoSubtitle` for `(versionId, transcript.language)` and return 201 `{ subtitle: { id, language, label, url: sourceUrl } }`. Catch the `'storage-quota'` error and answer `apiErrors.badRequest('Storage quota exceeded')`.

Run the api tests → PASS.

- [ ] **Step 5: Hook for editing and the pane dialog**

`components/video-page/hooks/use-transcript-segment-edit.ts`:

```ts
'use client';

import { useCallback, useState } from 'react';
import type { TranscriptSegment } from '@/components/video-page/transcript-pane';

export function useTranscriptSegmentEdit(versionId: string | null) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (
      segmentId: string,
      patch: { text: string; speaker?: string | null }
    ): Promise<TranscriptSegment | null> => {
      if (!versionId) return null;
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/versions/${versionId}/transcript/segments/${segmentId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          }
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message =
            typeof payload?.error === 'string' ? payload.error : 'Failed to save the line';
          setError(message);
          return null;
        }
        return (payload?.data?.segment as TranscriptSegment | undefined) ?? null;
      } catch {
        setError('Failed to save the line');
        return null;
      } finally {
        setSaving(false);
      }
    },
    [versionId]
  );

  return { save, saving, error, clearError: () => setError(null) };
}
```

Test `tests/component/hooks/use-transcript-segment-edit.test.ts`: PATCH body and URL, returns the segment on success, sets `error` from the payload on 400, and returns null without fetching when `versionId` is null.

`components/video-page/transcript-pane.tsx`: `TranscriptPane` gains an "Edit" affordance per row when `canManage`: add `onEditSegment: (segment: TranscriptSegment) => void` to `TranscriptRowProps`/`rowProps` and render a small `Pencil` icon button (`aria-label="Edit line"`) in the row header next to the time. The pane holds `const [editing, setEditing] = useState<TranscriptSegment | null>(null)` and renders a `Dialog` (title "Edit transcript line", a `Textarea` with the text, an `Input` for the speaker, Save/Cancel). Save calls `useTranscriptSegmentEdit(versionId).save(editing.id, { text, speaker })`; on success replace the segment in local `transcript.segments` (keep `position`) and close; errors show under the textarea. Move `TranscriptSegment` etc. exports as needed so the hook can import the type without a cycle (put the types in `components/video-page/types.ts` if the import from `transcript-pane` creates one).

- [ ] **Step 6: Captions without re-transcribing**

`components/video-page/hooks/use-subtitles.ts`, `generateSubtitles`: before the AI POST, check for a READY transcript:

```ts
const existing = await fetch(`/api/versions/${versionId}/transcript`, { cache: 'no-store' });
const existingPayload = await existing.json().catch(() => null);
const transcript = existingPayload?.data?.transcript as {
  status?: string;
  language?: string;
  segments?: Array<{ startSec: number; endSec: number }>;
} | null;
const timed = transcript?.segments?.some((segment) => segment.endSec > segment.startSec);
if (existing.ok && transcript?.status === 'READY' && timed) {
  const built = await fetch(`/api/versions/${versionId}/transcript/captions`, { method: 'POST' });
  const builtPayload = await built.json().catch(() => null);
  if (!built.ok) {
    generateInFlightRef.current = false;
    return readClientApiError(builtPayload, 'Failed to build captions from the transcript');
  }
  generateInFlightRef.current = false;
  await refresh();
  const builtLanguage = builtPayload?.data?.subtitle?.language as string | undefined;
  selectSubtitleLanguage((builtLanguage ?? transcript.language ?? language).toLowerCase());
  return null;
}
```

(the existing AI path follows unchanged). In `tests/component/hooks/use-subtitles.test.ts` add: `builds captions from a READY transcript instead of starting a transcription` (asserts the captions POST, no POST to `/transcript`, `isGeneratingSubtitles` stays false, the built language is selected) and `starts a transcription when there is no transcript` (existing behaviour; the GET answers `{ data: { transcript: null } }`).

`components/video-page/subtitle-controls.tsx`: the generate dialog description becomes `If this version already has a transcript, the captions are built from it; otherwise we transcribe it first. Either way the result is a track you can turn on in the player.`

- [ ] **Step 7: Verify and commit**

Run `bun run test`, the api files with the DATABASE_URL prefix, `bun run check`.

```bash
git add app lib components tests
git commit -m "feat(transcript): edit lines in place and build captions from the transcript

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Burn-in style, ASS builder and ffmpeg arguments (pure)

**Files:**

- Create: `lib/rough-cut/subtitle-style.ts`
- Test: `tests/unit/lib/rough-cut-subtitle-style.test.ts`

Context: burned-in subtitles are rendered by ffmpeg's `ass` filter (libass) from an ASS document we generate: one style (font, size, colours, outline or box, position) and one dialogue line per cue. Cues are regrouped from the transcript's timed words so the operator controls pacing (words per cue, max seconds per cue). An optional playback rate speeds the whole video up (`setpts`/`atempo`) and scales the cue times to match. Everything here is pure; the job (Task 10) feeds it words and dimensions.

- [ ] **Step 1: Failing tests**

Create `tests/unit/lib/rough-cut-subtitle-style.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assColor,
  assTime,
  BURN_IN_FONTS,
  buildAssDocument,
  burnInFfmpegArgs,
  escapeFfmpegFilterPath,
  parseBurnInStyle,
  regroupWordsIntoCues,
  scaleCueTimes,
} from '@/lib/rough-cut/subtitle-style';

const WORDS = [
  { start: 0, end: 0.4, text: 'We' },
  { start: 0.5, end: 0.9, text: 'help' },
  { start: 1, end: 1.6, text: 'founders' },
  { start: 1.7, end: 2.1, text: 'raise' },
  { start: 2.2, end: 2.8, text: 'faster.' },
  { start: 5, end: 5.4, text: 'Thanks.' },
];

describe('parseBurnInStyle', () => {
  it('fills defaults and refuses bad values', () => {
    const parsed = parseBurnInStyle({});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        font: 'dejavu-sans',
        fontSize: 48,
        textColor: '#FFFFFF',
        outlineColor: '#000000',
        outlineWidth: 2,
        backgroundOpacity: 0,
        position: 'bottom',
        marginVertical: 60,
        bold: true,
        uppercase: false,
        maxWordsPerCue: 6,
        maxCueSeconds: 4,
        playbackRate: 1,
      });
    }
    expect(parseBurnInStyle({ fontSize: 8 }).ok).toBe(false);
    expect(parseBurnInStyle({ textColor: 'red' }).ok).toBe(false);
    expect(parseBurnInStyle({ font: 'comic-sans' }).ok).toBe(false);
    expect(parseBurnInStyle({ playbackRate: 3 }).ok).toBe(false);
    expect(parseBurnInStyle({ extra: true }).ok).toBe(false);
  });
});

describe('regroupWordsIntoCues', () => {
  it('cuts at the word limit, the time limit and a long pause', () => {
    const style = {
      ...parseBurnInStyle({ maxWordsPerCue: 3, maxCueSeconds: 4 }),
      ok: true as const,
    };
    const cues = regroupWordsIntoCues(
      WORDS,
      style.ok
        ? (parseBurnInStyle({ maxWordsPerCue: 3, maxCueSeconds: 4 }) as { ok: true; value: never })
            .value
        : ({} as never)
    );
    void style;
    expect(cues).toEqual([
      { start: 0, end: 1.6, text: 'We help founders' },
      { start: 1.7, end: 2.8, text: 'raise faster.' },
      { start: 5, end: 5.6, text: 'Thanks.' },
    ]);
  });

  it('uppercases when asked and keeps a cue from running into the next one', () => {
    const value = (
      parseBurnInStyle({ maxWordsPerCue: 10, maxCueSeconds: 10, uppercase: true }) as {
        ok: true;
        value: Parameters<typeof regroupWordsIntoCues>[1];
      }
    ).value;
    const cues = regroupWordsIntoCues(
      [
        { start: 0, end: 0.1, text: 'a' },
        { start: 0.2, end: 0.3, text: 'b' },
      ],
      value
    );
    expect(cues).toEqual([{ start: 0, end: 0.9, text: 'A B' }]);
  });
});

describe('ASS output', () => {
  it('formats colours and times the ASS way', () => {
    expect(assColor('#FFFFFF')).toBe('&H00FFFFFF');
    expect(assColor('#FF8800')).toBe('&H000088FF');
    expect(assColor('#000000', 0.5)).toBe('&H80000000');
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(3725.456)).toBe('1:02:05.46');
  });

  it('writes one style from the options and one dialogue line per cue, scaled to the video height', () => {
    const value = (
      parseBurnInStyle({
        font: 'roboto',
        fontSize: 48,
        position: 'top',
        backgroundOpacity: 0.6,
        bold: false,
      }) as { ok: true; value: Parameters<typeof buildAssDocument>[1] }
    ).value;
    const doc = buildAssDocument([{ start: 1, end: 2.5, text: 'Hello {there}\nfriend' }], value, {
      width: 1280,
      height: 720,
    });
    expect(doc).toContain('PlayResX: 1280');
    expect(doc).toContain('PlayResY: 720');
    expect(doc).toContain(
      'Style: Default,Roboto,32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,0,0,0,0,100,100,0,0,3,2,0,8,40,40,40,1'
    );
    expect(doc).toContain(
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello (there)\\Nfriend'
    );
    expect(BURN_IN_FONTS.find((font) => font.id === 'roboto')?.family).toBe('Roboto');
  });
});

describe('burnInFfmpegArgs', () => {
  it('uses the ass filter at normal speed and re-times video and audio at another', () => {
    const value = (
      parseBurnInStyle({}) as { ok: true; value: Parameters<typeof burnInFfmpegArgs>[3] }
    ).value;
    const plain = burnInFfmpegArgs('/tmp/in.mp4', '/tmp/subs:1.ass', '/tmp/out.mp4', value);
    expect(plain).toContain('-vf');
    expect(plain[plain.indexOf('-vf') + 1]).toBe("ass='/tmp/subs\\:1.ass'");
    expect(plain).not.toContain('-filter_complex');
    expect(plain[plain.length - 1]).toBe('/tmp/out.mp4');

    const fast = burnInFfmpegArgs('/tmp/in.mp4', '/tmp/subs.ass', '/tmp/out.mp4', {
      ...value,
      playbackRate: 1.25,
    });
    expect(fast[fast.indexOf('-filter_complex') + 1]).toBe(
      "[0:v]setpts=PTS/1.25,ass='/tmp/subs.ass'[v];[0:a]atempo=1.25[a]"
    );
    expect(fast).toContain('[v]');
    expect(fast).toContain('[a]');
    expect(escapeFfmpegFilterPath("/a'b,c[d]")).toBe("/a\\'b\\,c\\[d\\]");
  });

  it('scales cue times by the playback rate', () => {
    expect(scaleCueTimes([{ start: 2, end: 4, text: 'x' }], 2)).toEqual([
      { start: 1, end: 2, text: 'x' },
    ]);
  });
});
```

The odd-looking casts in the `regroupWordsIntoCues` tests are only there because `parseBurnInStyle` returns a result union; write a tiny local `style(overrides)` helper that unwraps it and use it everywhere instead of those casts.

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-subtitle-style.test.ts` → FAIL.

- [ ] **Step 2: Implement**

Create `lib/rough-cut/subtitle-style.ts`:

```ts
import { z } from 'zod';
import type { TimedWord } from './text';
import type { VttCue } from './vtt';

/**
 * Burned-in subtitles: the style the operator picked, the ASS document
 * libass renders from it, and the ffmpeg arguments. Pure; the job supplies
 * words and video dimensions.
 */

export const BURN_IN_FONTS = [
  { id: 'dejavu-sans', family: 'DejaVu Sans', label: 'DejaVu Sans' },
  { id: 'liberation-sans', family: 'Liberation Sans', label: 'Liberation Sans (Arial-like)' },
  { id: 'roboto', family: 'Roboto', label: 'Roboto' },
  { id: 'open-sans', family: 'Open Sans', label: 'Open Sans' },
  { id: 'liberation-serif', family: 'Liberation Serif', label: 'Liberation Serif (Times-like)' },
  { id: 'dejavu-sans-mono', family: 'DejaVu Sans Mono', label: 'DejaVu Sans Mono' },
] as const;
export type BurnInFontId = (typeof BURN_IN_FONTS)[number]['id'];
const FONT_IDS = BURN_IN_FONTS.map((font) => font.id) as [BurnInFontId, ...BurnInFontId[]];

export const BURN_IN_POSITIONS = ['bottom', 'center', 'top'] as const;
export type BurnInPosition = (typeof BURN_IN_POSITIONS)[number];

/** Font sizes are given for a 1080-pixel-high frame and scaled to the real height. */
export const BURN_IN_REFERENCE_HEIGHT = 1080;
/** A pause longer than this between words starts a new cue. */
export const BURN_IN_CUE_GAP_SECONDS = 1;
/** A cue never disappears faster than this after its last word, unless the next cue starts. */
export const BURN_IN_MIN_CUE_SECONDS = 0.6;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const burnInStyleSchema = z
  .object({
    font: z.enum(FONT_IDS).default('dejavu-sans'),
    fontSize: z.number().int().min(16).max(120).default(48),
    textColor: z.string().regex(HEX_COLOR).default('#FFFFFF'),
    outlineColor: z.string().regex(HEX_COLOR).default('#000000'),
    outlineWidth: z.number().min(0).max(6).default(2),
    /** 0 draws an outline only; above 0 draws a box behind the text with this opacity. */
    backgroundOpacity: z.number().min(0).max(1).default(0),
    position: z.enum(BURN_IN_POSITIONS).default('bottom'),
    marginVertical: z.number().int().min(0).max(400).default(60),
    bold: z.boolean().default(true),
    uppercase: z.boolean().default(false),
    maxWordsPerCue: z.number().int().min(1).max(14).default(6),
    maxCueSeconds: z.number().min(0.5).max(10).default(4),
    /** 1 keeps the timing; anything else re-times video, audio and cues together. */
    playbackRate: z.number().min(0.5).max(2).default(1),
  })
  .strict();

export type BurnInStyle = z.infer<typeof burnInStyleSchema>;

export function parseBurnInStyle(
  input: unknown
): { ok: true; value: BurnInStyle } | { ok: false; error: string } {
  const parsed = burnInStyleSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: first ? `${first.path.join('.') || 'style'}: ${first.message}` : 'Invalid style',
    };
  }
  return { ok: true, value: parsed.data };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Words become cues by count, duration and pauses; a cue holds until its last word plus a beat, never into the next cue. */
export function regroupWordsIntoCues(words: TimedWord[], style: BurnInStyle): VttCue[] {
  const ordered = [...words].filter((word) => word.text.trim()).sort((a, b) => a.start - b.start);
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  for (const word of ordered) {
    const first = current[0];
    const last = current[current.length - 1];
    const breaks =
      current.length >= style.maxWordsPerCue ||
      (first !== undefined && word.end - first.start > style.maxCueSeconds) ||
      (last !== undefined && word.start - last.end > BURN_IN_CUE_GAP_SECONDS);
    if (breaks && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const next = groups[index + 1];
    const lastEnd = group[group.length - 1]!.end;
    const held = Math.max(lastEnd, group[0]!.start + BURN_IN_MIN_CUE_SECONDS);
    const end = next ? Math.min(held, next[0]!.start) : held;
    const text = group.map((word) => word.text.trim()).join(' ');
    return {
      start: round3(group[0]!.start),
      end: round3(Math.max(end, group[0]!.start)),
      text: style.uppercase ? text.toUpperCase() : text,
    };
  });
}

export function scaleCueTimes(cues: VttCue[], rate: number): VttCue[] {
  if (rate === 1) return cues;
  return cues.map((cue) => ({
    ...cue,
    start: round3(cue.start / rate),
    end: round3(cue.end / rate),
  }));
}

/** `#RRGGBB` (+ alpha 0–1, 0 opaque) to ASS `&HAABBGGRR`. */
export function assColor(hex: string, alpha = 0): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

/** `H:MM:SS.cc` */
export function assTime(seconds: number): string {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centis = Math.round((total - Math.floor(total)) * 100);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}

function assText(text: string): string {
  // Braces would open an override block; newlines are ASS line breaks.
  return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\r?\n/g, '\\N');
}

const ALIGNMENT: Record<BurnInPosition, number> = { bottom: 2, center: 5, top: 8 };

export function buildAssDocument(
  cues: VttCue[],
  style: BurnInStyle,
  video: { width: number; height: number }
): string {
  const font = BURN_IN_FONTS.find((entry) => entry.id === style.font) ?? BURN_IN_FONTS[0];
  const scale = video.height / BURN_IN_REFERENCE_HEIGHT;
  const fontSize = Math.max(8, Math.round(style.fontSize * scale));
  const margin = Math.round(style.marginVertical * scale);
  const boxed = style.backgroundOpacity > 0;
  const styleLine = [
    'Default',
    font.family,
    String(fontSize),
    assColor(style.textColor),
    assColor(style.textColor),
    assColor(style.outlineColor),
    boxed ? assColor(style.outlineColor, 1 - style.backgroundOpacity) : assColor('#000000', 0.5),
    style.bold ? '-1' : '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    boxed ? '3' : '1',
    String(style.outlineWidth),
    '0',
    String(ALIGNMENT[style.position]),
    '40',
    '40',
    String(margin),
    '1',
  ].join(',');
  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assText(cue.text)}`
  );
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${video.width}`,
    `PlayResY: ${video.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${styleLine}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}

/** ffmpeg filter option values need these characters escaped. */
export function escapeFfmpegFilterPath(path: string): string {
  return path
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/;/g, '\\;');
}

export function burnInFfmpegArgs(
  inputPath: string,
  assPath: string,
  outputPath: string,
  style: BurnInStyle
): string[] {
  const ass = `ass='${escapeFfmpegFilterPath(assPath)}'`;
  const encode = [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    outputPath,
  ];
  if (style.playbackRate === 1) {
    return [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-vf',
      ass,
      ...encode,
    ];
  }
  const rate = String(style.playbackRate);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-filter_complex',
    `[0:v]setpts=PTS/${rate},${ass}[v];[0:a]atempo=${rate}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    ...encode,
  ];
}
```

The `regroupWordsIntoCues` expectations in Step 1 follow from these rules: with three words per cue the first cue ends at 1.6 (last word end, already past the 0.6 s minimum), the second at 2.8, the last `Thanks.` alone holds 0.6 s. Adjust nothing in the implementation to make a test pass; if a test expectation is wrong, fix the expectation and say so in the commit.

Run the unit file → PASS. Then `bun run check`.

- [ ] **Step 3: Commit**

```bash
git add lib/rough-cut/subtitle-style.ts tests/unit/lib/rough-cut-subtitle-style.test.ts
git commit -m "feat(subtitles): burn-in style schema, ASS builder and ffmpeg arguments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The BURN_SUBTITLES job, worker wiring and fonts

**Files:**

- Create: `lib/rough-cut/burn-in-job.ts`
- Create: `worker/src/burn-in.ts` (re-export)
- Modify: `worker/src/index.ts` (queue, dispatch, deps)
- Modify: `worker/Dockerfile` (fonts)
- Test: `tests/unit/lib/rough-cut-burn-in-job.test.ts`

Context: the job takes a version, a style (Task 9) and a caption source, renders the subtitles into the picture with ffmpeg, and adds the result as a new version of the same video, carrying the transcript and caption track forward (re-timed when the playback rate changed) so the new version is reviewable and searchable without another transcription.

- [ ] **Step 1: Failing job test**

Create `tests/unit/lib/rough-cut-burn-in-job.test.ts` with a fake pool like the materialize test (Task 6). Answer: `FROM video_versions vv` (the version row: `id 'ver-1'`, `providerId 'r2'`, `videoId 'videos/in.mp4'`, `originalUrl '/api/upload/video/in.mp4'`, `videoParentId 'vid-1'`, `duration 10`, `title 'Talk'`), `SELECT DISTINCT ON (version_id)`/`FROM transcripts` (one READY transcript `t-1`, language `en`), `FROM transcript_segments` (one segment 0–3 with three timed words), `COALESCE(MAX("versionNumber")` → `{ max: 1 }`, `INSERT INTO transcripts` → `[{ id: 't-2' }]`, `SELECT p."ownerId"` → `[{ owner_id: 'owner' }]`. Deps: `run` records args and answers ffprobe with `{ stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1280, height: 720 }] }), code: 0 }`, ffmpeg with `{ code: 0 }`; `downloadVersionMedia` records the version and writes nothing; `uploadObject` records keys; `readOutput` returns `Buffer.from('mp4')`; `writeFile` is a dep too (`writeText(path, text)`) so the ASS content can be asserted.

Tests:

1. `burns the transcript into a new version and carries transcript and captions forward`: payload `{ style: parseBurnInStyle({ maxWordsPerCue: 2 }).value, source: { kind: 'transcript', transcriptId: 't-1' } }`. Assert: ffprobe then ffmpeg ran; the ffmpeg args contain `-vf` with `ass='…'`; the written ASS text contains `PlayResX: 1280` and two `Dialogue:` lines; one `uploadObject` under `videos/` with `video/mp4`; `UPDATE video_versions SET "isActive" = false` for `vid-1`; `INSERT INTO video_versions` with `versionNumber 2`, label `Subtitled`, and `duration 10`; `INSERT INTO transcripts` params `[<new id>, 'en', 'burn-in', <text>]`; segment insert with the same word times; one `subtitles/` upload; a `PROBE_MEDIA` media job for the new version.
2. `re-times the copied transcript when the playback rate is not 1`: style `playbackRate: 2` → the copied segment's `start_sec`/`end_sec` are halved, the new version's duration is 5, the label is `Subtitled 2x`, and ffmpeg args contain `setpts=PTS/2`.
3. `uses a caption track when asked and fails clearly with no source`: `source: { kind: 'subtitle', subtitleId: 's-1' }` → the job downloads `subtitles/<file>.vtt` (answer `SELECT "sourceUrl" FROM video_subtitles` with `/api/upload/subtitle/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.vtt` and `downloadObject` writes a VTT string through a `readText` dep) and burns its cues; with a version that has neither transcript nor track the job throws `/no transcript or caption track/` and runs no ffmpeg.

- [ ] **Step 2: Implement the job**

Create `lib/rough-cut/burn-in-job.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { wordsFromSegments } from './beats';
import { persistDerivedTranscript, type DerivedSegment } from './derived-transcript';
import {
  buildAssDocument,
  burnInFfmpegArgs,
  parseBurnInStyle,
  regroupWordsIntoCues,
  scaleCueTimes,
  type BurnInStyle,
} from './subtitle-style';
import type { TimedWord } from './text';
import type { TranscriptSegmentRow } from './transcript-source';
import type { VttCue } from './vtt';

export const BURN_IN_PROVIDER = 'burn-in';

export type BurnInSource =
  | { kind: 'transcript'; transcriptId: string | null }
  | { kind: 'subtitle'; subtitleId: string };

export type BurnInPayload = { style: BurnInStyle; source: BurnInSource; requestedById?: string };

export type BurnInDeps = {
  pool: Pool;
  run: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  downloadObject: (key: string, dest: string) => Promise<void>;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  downloadVersionMedia: (
    version: { providerId: string; videoId: string; originalUrl: string },
    dest: string
  ) => Promise<void>;
  readOutput?: (path: string) => Promise<Buffer>;
  readText?: (path: string) => Promise<string>;
  writeText?: (path: string, text: string) => Promise<void>;
};

export function parseBurnInPayload(value: unknown): BurnInPayload | null {
  /* zod: style through parseBurnInStyle, source one of the two shapes; null when invalid */
}
```

Then `export async function burnInSubtitles(deps: BurnInDeps, versionId: string, payload: BurnInPayload): Promise<void>` doing, in order:

1. Load the version (`SELECT vv.id, vv."providerId", vv."videoId", vv."originalUrl", vv."videoParentId", vv.duration, vv.title FROM video_versions vv WHERE vv.id = $1`).
2. Resolve the words and the language: `source.kind === 'subtitle'` → `SELECT "sourceUrl", language FROM video_subtitles WHERE id = $1 AND "versionId" = $2`, download `subtitles/<file>` (file = last path segment), parse with a small local VTT parser (timing line `-->`, text lines; strip tags) into cues, then words by spreading each cue's text evenly (same rule as `flattenSource` in derived-transcript, expose a `spreadCueWords(cue)` helper there or duplicate the six lines); `source.kind === 'transcript'` → the given transcript id, else the version's oldest READY transcript (`ORDER BY created_at ASC`); segments via `SELECT start_sec, end_sec, speaker, text, words … ORDER BY position`; words via `wordsFromSegments(segments, 0)` (0 means no clamp). No words → `throw new Error('This version has no transcript or caption track to burn in')`.
3. `cues = scaleCueTimes(regroupWordsIntoCues(words, style), style.playbackRate)`.
4. Temp dir; `downloadVersionMedia(version, source.bin)`; ffprobe `-v error -select_streams v:0 -show_entries stream=width,height -of json` → `{ width, height }` (fallback 1920×1080 when missing); write the ASS via `deps.writeText ?? writeFile`; run ffmpeg with `burnInFfmpegArgs`; `body = (deps.readOutput ?? readFile)(output)`.
5. Upload `videos/<uuid>.mp4`; new version on the same video: `COALESCE(MAX("versionNumber"))+1`, `UPDATE video_versions SET "isActive" = false WHERE "videoParentId" = $1`, INSERT with label `Subtitled` (or `Subtitled ${rate}x` when `rate !== 1`), `title = version.title`, `duration = Math.round(duration / rate)` when the source had one, `proxy_status 'SKIPPED'`, `isActive true`.
6. Carry the transcript forward: `DerivedSegment[]` built from the source segments (transcript case) or the cues (subtitle case), every time divided by `playbackRate`; `persistDerivedTranscript(deps, { versionId: newVersionId, language, provider: BURN_IN_PROVIDER, segments })` inside try/catch that logs and continues.
7. `INSERT INTO media_jobs … 'PROBE_MEDIA'` for the new version.
8. `finally` remove the temp dir.

`worker/src/burn-in.ts`:

```ts
export { burnInSubtitles, parseBurnInPayload } from '../lib/rough-cut/burn-in-job';
export type { BurnInDeps, BurnInPayload } from '../lib/rough-cut/burn-in-job';
```

`worker/src/index.ts`: add `BURN_SUBTITLES: 'burn-subtitles'` to `QUEUE`, the `queueForKind` mapping, a `boss.work(QUEUE.BURN_SUBTITLES, …)` block, and in `runMediaJob`:

```ts
    } else if (kind === 'BURN_SUBTITLES') {
      const payload = parseBurnInPayload(data.payload);
      if (!payload) throw new Error('BURN_SUBTITLES payload is invalid');
      await burnInSubtitles(
        { pool, run, downloadObject, uploadObject, downloadVersionMedia: downloadVersionFile },
        data.versionId,
        payload
      );
```

`worker/Dockerfile`: add `fonts-dejavu-core fonts-liberation2 fonts-roboto fonts-open-sans fontconfig` to the `apt-get install` line (libass reads them through fontconfig; ffmpeg from Debian is built with libass).

Run: `bun run vitest run --project unit tests/unit/lib/rough-cut-burn-in-job.test.ts` → PASS; `bun run test`; `bun run check`.

- [ ] **Step 3: Commit**

```bash
git add lib worker tests
git commit -m "feat(subtitles): BURN_SUBTITLES media job renders styled captions into a new version

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Burn-in API

**Files:**

- Create: `app/api/videos/[videoId]/burn-in/route.ts`
- Modify: `tests/api/auth-matrix.test.ts`
- Test: `tests/api/burn-in.test.ts`

Context: editors start a burn-in for a version of a video they manage and poll its job. Guests and share-link viewers can see nothing here; the route uses the same editor gate as subtitle uploads.

- [ ] **Step 1: Failing API tests**

Create `tests/api/burn-in.test.ts` (seed with `seedVersion({ providerId: 'r2' })`, `createReadyTranscript` for the version, `addProjectMember` for a VIEWER):

1. `POST` 401 anonymous, 403 viewer member, both leave `media_jobs` empty.
2. `POST` 400 when the version has no READY transcript and no subtitle track (`'This version has no transcript or caption track to burn in'`), no job row.
3. `POST` 400 for an invalid style (`{ versionId, style: { fontSize: 4 } }`), no job row.
4. `POST` happy path for the owner: `{ versionId, style: { font: 'roboto', fontSize: 56 } }` → 202 `{ job: { id, status: 'PENDING' } }`; the `media_jobs` row has kind `BURN_SUBTITLES`, `versionId`, and payload `{ style: { …defaults, font: 'roboto', fontSize: 56 }, source: { kind: 'transcript', transcriptId: <the READY transcript id> }, requestedById: owner.id }`.
5. `POST` 409 while a job is PENDING/QUEUED/RUNNING for the version (second call), still one row.
6. `GET ?versionId=` returns `{ job: null }` before, and `{ job: { id, status: 'PENDING', error: null, createdAt, finishedAt: null } }` after; 403 for an anonymous caller on a private project.

Add the route to `tests/api/auth-matrix.test.ts` (POST body `{ versionId: f.versionId, style: {} }`).

- [ ] **Step 2: Route**

`app/api/videos/[videoId]/burn-in/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { MediaJobKind, MediaJobStatus, TranscriptStatus, type Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { rateLimit } from '@/lib/rate-limit';
import { parseBurnInStyle } from '@/lib/rough-cut/subtitle-style';
import { getVideoAssetAccessContext } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string }> };

const ACTIVE: MediaJobStatus[] = [
  MediaJobStatus.PENDING,
  MediaJobStatus.QUEUED,
  MediaJobStatus.RUNNING,
];

function shapeJob(job: {
  id: string;
  status: MediaJobStatus;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

// GET /api/videos/[videoId]/burn-in?versionId=… — the latest burn-in job of a version.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'subtitle-list');
    if (limited) return limited;
    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.viewerUserId || !context.canManageAssets)
      return apiErrors.forbidden('Access denied');
    const versionId = request.nextUrl.searchParams.get('versionId')?.trim();
    if (!versionId) return apiErrors.badRequest('versionId is required');
    const job = await db.mediaJob.findFirst({
      where: { versionId, kind: MediaJobKind.BURN_SUBTITLES, version: { videoParentId: videoId } },
      orderBy: { createdAt: 'desc' },
    });
    return withCacheControl(
      successResponse({ job: job ? shapeJob(job) : null }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error loading burn-in job:', error);
    return apiErrors.internalError('Failed to load the burn-in job');
  }
}

// POST /api/videos/[videoId]/burn-in — burn the version's transcript (or a caption track) into a new version.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.viewerUserId || !context.canManageAssets)
      return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const versionId = typeof body?.versionId === 'string' ? body.versionId.trim() : '';
    if (!versionId) return apiErrors.badRequest('versionId is required');
    const style = parseBurnInStyle(body?.style);
    if (!style.ok) return apiErrors.badRequest(style.error);

    const version = await db.videoVersion.findFirst({
      where: { id: versionId, videoParentId: videoId },
      select: { id: true, providerId: true, video: { select: { kind: true } } },
    });
    if (!version) return apiErrors.notFound('Version');
    if (
      version.video.kind !== 'VIDEO' ||
      (version.providerId !== 'r2' && version.providerId !== 'bunny')
    ) {
      return apiErrors.badRequest('Subtitles can only be burned into an uploaded video file');
    }

    const subtitleId = typeof body?.subtitleId === 'string' ? body.subtitleId.trim() : '';
    let source:
      | { kind: 'transcript'; transcriptId: string }
      | { kind: 'subtitle'; subtitleId: string };
    if (subtitleId) {
      const track = await db.videoSubtitle.findFirst({
        where: { id: subtitleId, versionId },
        select: { id: true },
      });
      if (!track) return apiErrors.notFound('Subtitle track');
      source = { kind: 'subtitle', subtitleId: track.id };
    } else {
      const transcript = await db.transcript.findFirst({
        where: { versionId, status: TranscriptStatus.READY },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!transcript) {
        const anyTrack = await db.videoSubtitle.findFirst({
          where: { versionId },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        if (!anyTrack)
          return apiErrors.badRequest('This version has no transcript or caption track to burn in');
        source = { kind: 'subtitle', subtitleId: anyTrack.id };
      } else {
        source = { kind: 'transcript', transcriptId: transcript.id };
      }
    }

    const active = await db.mediaJob.findFirst({
      where: { versionId, kind: MediaJobKind.BURN_SUBTITLES, status: { in: ACTIVE } },
      select: { id: true },
    });
    if (active) return apiErrors.conflict('A burn-in is already running for this version');

    const jobId = await enqueueMediaJob(versionId, MediaJobKind.BURN_SUBTITLES, {
      style: style.value,
      source,
      requestedById: context.viewerUserId,
    } as unknown as Prisma.InputJsonValue);
    return withCacheControl(
      successResponse({ job: { id: jobId, status: 'PENDING' } }, 202),
      'private, no-store'
    );
  } catch (error) {
    logError('Error enqueueing burn-in:', error);
    return apiErrors.internalError('Failed to start the burn-in');
  }
}
```

Check the `MediaJob` ↔ `VideoVersion` relation name for the `version: { videoParentId }` filter (`MediaJob.version` exists in the schema).

Run the api file + auth-matrix → PASS. `bun run check`.

- [ ] **Step 3: Commit**

```bash
git add app tests
git commit -m "feat(subtitles): burn-in job endpoints

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Burn-in dialog in the player

**Files:**

- Create: `components/video-page/hooks/use-burn-in.ts`
- Create: `components/video-page/burn-in-dialog.tsx`
- Modify: `components/video-page/subtitle-controls.tsx` (menu entry + button)
- Modify: `components/video-page/player-core.tsx` (pass the new props through)
- Modify: `components/video-page-content.tsx` (hook, dialog, reload on completion)
- Test: `tests/component/hooks/use-burn-in.test.ts`, `tests/component/subtitle-controls.test.tsx`

- [ ] **Step 1: Failing hook test**

`tests/component/hooks/use-burn-in.test.ts` (fetch stub + fake timers, like `use-subtitles.test.ts`):

1. `start posts the style and begins polling`: `await act(() => result.current.start({ fontSize: 56 }))` → `POST /api/videos/video-1/burn-in` with body `{ versionId: 'version-1', style: { fontSize: 56 } }`; `result.current.job` is `{ id: 'job-1', status: 'PENDING' }`; `isRunning` true.
2. `polls every four seconds until the job succeeds, then calls onDone once`: GET answers `RUNNING` then `SUCCEEDED`; after advancing timers `onDone` was called once, `isRunning` is false, polling stops.
3. `surfaces the job error on FAILED and the API error on a refused start`: FAILED → `error` is the job's error; a 409 start → `start` returns the message and `job` stays null.

- [ ] **Step 2: Hook**

`components/video-page/hooks/use-burn-in.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BurnInStyle } from '@/lib/rough-cut/subtitle-style';

export const BURN_IN_POLL_MS = 4000;

export type BurnInJob = { id: string; status: string; error?: string | null };

function readClientApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

export function useBurnIn(options: {
  videoId: string;
  versionId: string | null;
  onDone?: () => void;
}) {
  const { videoId, versionId } = options;
  const [job, setJob] = useState<BurnInJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const onDoneRef = useRef(options.onDone);
  onDoneRef.current = options.onDone;

  useEffect(() => {
    setJob(null);
    setError(null);
  }, [versionId]);

  const isRunning =
    job !== null &&
    (job.status === 'PENDING' || job.status === 'QUEUED' || job.status === 'RUNNING');

  useEffect(() => {
    if (!isRunning || !versionId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/videos/${videoId}/burn-in?versionId=${encodeURIComponent(versionId)}`,
          { cache: 'no-store' }
        );
        const payload = await response.json().catch(() => null);
        if (cancelled || !response.ok) return;
        const next = payload?.data?.job as BurnInJob | null;
        if (!next) return;
        setJob(next);
        if (next.status === 'SUCCEEDED') onDoneRef.current?.();
        if (next.status === 'FAILED') setError(next.error ?? 'The burn-in failed');
      } catch {
        // the next tick retries
      }
    };
    const timer = window.setInterval(() => void poll(), BURN_IN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isRunning, versionId, videoId]);

  const start = useCallback(
    async (style: Partial<BurnInStyle>, subtitleId?: string): Promise<string | null> => {
      if (!versionId) return 'No version selected';
      setStarting(true);
      setError(null);
      try {
        const response = await fetch(`/api/videos/${videoId}/burn-in`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ versionId, style, ...(subtitleId ? { subtitleId } : {}) }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const message = readClientApiError(payload, 'Failed to start the burn-in');
          setError(message);
          return message;
        }
        setJob((payload?.data?.job as BurnInJob | undefined) ?? null);
        return null;
      } catch {
        setError('Failed to start the burn-in');
        return 'Failed to start the burn-in';
      } finally {
        setStarting(false);
      }
    },
    [versionId, videoId]
  );

  return { job, error, starting, isRunning, start };
}
```

- [ ] **Step 3: Dialog and wiring**

`components/video-page/burn-in-dialog.tsx`: a `Dialog` titled "Burn subtitles into a new version" with form state for every `BurnInStyle` field: font (`Select` over `BURN_IN_FONTS`), font size (`<input type="range" min=16 max=120>` with the value shown), text colour and outline colour (`<input type="color">`), outline width (range 0–6, step 0.5), background opacity (range 0–1, step 0.1, labelled "Box behind text"), position (`Select`: Bottom/Centre/Top), bottom/top margin (range 0–400), bold and uppercase checkboxes, words per caption (range 1–14, labelled "Caption speed: fewer words = faster changes"), max seconds per caption (range 0.5–10, step 0.5), playback speed (`Select` 0.9×/1×/1.1×/1.25×/1.5×). A preview box (`aspect-video`, dark background) renders a sample line with the chosen font family (fallback stack), size scaled to the box (`fontSize * boxHeight / 1080`), colours, `text-shadow` outline or a box background, and vertical placement. Footer: Cancel and `Burn in` (spinner while `starting`); the dialog explains that the result lands as a new version of this video and that the current version stays. Props: `open`, `onOpenChange`, `onStart: (style: Partial<BurnInStyle>) => Promise<string | null>`, `starting`, `canStart` (false without a transcript/track, with the reason shown), `subtitles` (tracks, to pick a caption source when the version has no transcript: a `Select` "Caption source" listing "Transcript" plus each track).

`components/video-page/subtitle-controls.tsx`: new optional props `onBurnIn?: () => void` and `burnInRunning?: boolean`; when `canManageSubtitles && onBurnIn`, add a `DropdownMenuItem` "Burn subtitles into a new version" (icon `Flame` from lucide) after "Generate with AI", disabled while `burnInRunning` (label `Burning in…`). Add a test in `tests/component/subtitle-controls.test.tsx`: the item appears with `onBurnIn` and calls it; it is absent without it.

`components/video-page/player-core.tsx`: accept `onBurnIn?: () => void` and `burnInRunning?: boolean` and pass them to `SubtitleControls`.

`components/video-page-content.tsx`:

```tsx
const [burnInOpen, setBurnInOpen] = useState(false);
const burnIn = useBurnIn({
  videoId,
  versionId: activeVersionId,
  onDone: () => {
    toast.success('Subtitled version ready');
    void reloadVideo();
  },
});
```

Pass `onBurnIn={canManageCaptions && supportsSubtitles ? () => setBurnInOpen(true) : undefined}` and `burnInRunning={burnIn.isRunning}` to the player; render `<BurnInDialog open={burnInOpen} onOpenChange={setBurnInOpen} starting={burnIn.starting} canStart={supportsSubtitles} subtitles={subtitles} onStart={async (style) => { const err = await burnIn.start(style); if (!err) { toast.success('Burning subtitles in. A new version appears here when it is done.'); setBurnInOpen(false); } return err; }} />`. When `burnIn.error` changes to a value, `toast.error(burnIn.error)` (in an effect). `toast` comes from `sonner`, already used on the page.

Run `bun run test`, `bun run check`.

- [ ] **Step 4: Commit**

```bash
git add components tests
git commit -m "feat(subtitles): burn-in dialog with font, colour, position, pacing and speed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Documentation and final verification

**Files:**

- Create: `docs/superpowers/specs/2026-09-05-transcript-first-editing-design.md`
- Modify: `docs/superpowers/specs/2026-09-04-editorial-brief-design.md` (phase 5 and 6 status)
- Modify: `INTERNAL.md` (worker fonts, new job kind, transcript-first rule, 2-hour wait)
- Modify: `README.md` ("Versioning and comparison" / features: burned-in subtitles, transcript editing, cut review)

- [ ] **Step 1: Write the design note**

`docs/superpowers/specs/2026-09-05-transcript-first-editing-design.md`, sections: Problem (the three observations from the operator's test: repeated takes, a manual re-transcription, captions transcribing again), Decisions (transcript required when transcription is on, 2-hour wait, auto-enqueue at run creation and in the job; containment grouping; script alignment with `script_match` first; derived transcript on every render; overrides keyed by island / source range; re-render as a new version of the output video; burn-in as a media job into a new version with the transcript carried forward), Data model (the four `rough_cuts` columns, `BURN_SUBTITLES`), API (each new route, one line each), UI (script textarea, Cuts tab, transcript line editing, captions-from-transcript, burn-in dialog), Warnings (`script-lines-missing`, `off-script-beats`, `script-ignored`, `script-unreadable`), Out of scope (markers re-placement after overrides, per-viewer forensic marks, model-backed script alignment).

In the editorial-brief spec, mark phase 5 as **Done** (overrides route, `applyOverrides`, re-materialize as a new version; regenerate-with-pins not built: overrides survive because they are keyed by source range and re-rendering reuses the same run) and phase 6 as **Done** (Cuts tab on the output video with a source preview).

`INTERNAL.md`: in the env table, note that with `OPENFRAME_ENABLE_TRANSCRIPTION=true` a rough cut waits for transcripts (up to two hours) and fails rather than falling back; in "Services", add that the worker also burns subtitles (`BURN_SUBTITLES`) and needs the fonts the Dockerfile installs; in "After pulling master", add `bun run db:migrate` for `20260907100000_transcript_first_editing`.

`README.md`: add bullets for editing transcript lines in place, captions built from the transcript, burned-in subtitle versions, and reviewing a rough cut's removals against the source.

- [ ] **Step 2: Full verification**

Run, in the worktree:

```bash
bun run check
bun run test
DATABASE_URL="postgresql://openframe:openframe@127.0.0.1:55432/openframe_test?schema=public" bun run test:api
```

All three must pass. Then `git status` must be clean after the commit below.

- [ ] **Step 3: Commit**

```bash
git add docs INTERNAL.md README.md
git commit -m "docs: transcript-first editing, cut review and burn-in

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: (1) transcript first + no repeated takes → Tasks 1, 2, 3; (2) transcript follows the cut and lands polished on the review version → Task 6; (3) optional original script as the guide → Tasks 2, 3; (4) the same text drives subtitles → Tasks 6, 8; (5) edit words in the transcript → Task 8; (6) burned-in subtitles with colour, font, size, pacing, speed → Tasks 9–12; (7) review the uncut source, revert or modify cuts → Tasks 4, 5, 7.
- Type consistency: `RoughCutOverrides` (`cuts`, `extraCuts`), `applyOverrides`, `overridesEqual`, `extraCutKey` are named identically in Tasks 4, 5, 7; `persistDerivedTranscript` / `DerivedSegment` in Tasks 6 and 10; `parseBurnInStyle` / `BurnInStyle` in Tasks 9–12; `shapeRoughCut(row, { includeScript })` in Tasks 2 and 5.
