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
