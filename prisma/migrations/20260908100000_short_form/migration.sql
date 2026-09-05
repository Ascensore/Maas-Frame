ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS 'SHORTS';
ALTER TYPE "MediaJobKind" ADD VALUE IF NOT EXISTS 'ANALYZE_SHORT_FORM';
ALTER TYPE "MediaJobKind" ADD VALUE IF NOT EXISTS 'RENDER_SHORT_FORM';

CREATE TYPE "ShortFormBatchStatus" AS ENUM ('PENDING', 'ANALYZING', 'RANKING', 'READY', 'FAILED');
CREATE TYPE "ShortFormCandidateStatus" AS ENUM ('PROPOSED', 'REJECTED', 'APPROVED', 'RENDERING', 'READY', 'FAILED');
CREATE TYPE "ShortFormCropMode" AS ENUM ('AUTO', 'MANUAL', 'PADDED');

CREATE TABLE "short_form_batches" (
  "id" TEXT NOT NULL,
  "rough_cut_id" TEXT NOT NULL,
  "source_version_id" TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "agent_run_id" TEXT,
  "status" "ShortFormBatchStatus" NOT NULL DEFAULT 'PENDING',
  "config" JSONB NOT NULL,
  "warnings" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "short_form_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "short_form_candidates" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "rank" INTEGER NOT NULL,
  "source_start_sec" DOUBLE PRECISION NOT NULL,
  "source_end_sec" DOUBLE PRECISION NOT NULL,
  "score" DOUBLE PRECISION NOT NULL,
  "scores" JSONB NOT NULL,
  "rationale" TEXT,
  "title" TEXT NOT NULL,
  "social_caption" TEXT NOT NULL DEFAULT '',
  "hashtags" JSONB NOT NULL DEFAULT '[]',
  "crop_mode" "ShortFormCropMode" NOT NULL DEFAULT 'AUTO',
  "crop_track" JSONB,
  "focus_x" DOUBLE PRECISION,
  "focus_y" DOUBLE PRECISION,
  "caption_style" JSONB NOT NULL,
  "status" "ShortFormCandidateStatus" NOT NULL DEFAULT 'PROPOSED',
  "output_video_id" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "short_form_candidates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "short_form_batches_agent_run_id_key" ON "short_form_batches"("agent_run_id");
CREATE INDEX "short_form_batches_rough_cut_id_created_at_idx" ON "short_form_batches"("rough_cut_id", "created_at" DESC);
CREATE INDEX "short_form_batches_source_version_id_status_idx" ON "short_form_batches"("source_version_id", "status");
CREATE UNIQUE INDEX "short_form_batches_active_source_key" ON "short_form_batches"("source_version_id")
  WHERE "status" IN ('PENDING', 'ANALYZING', 'RANKING');
CREATE UNIQUE INDEX "short_form_candidates_batch_id_rank_key" ON "short_form_candidates"("batch_id", "rank");
CREATE INDEX "short_form_candidates_batch_id_status_idx" ON "short_form_candidates"("batch_id", "status");
CREATE INDEX "short_form_candidates_output_video_id_idx" ON "short_form_candidates"("output_video_id");

ALTER TABLE "short_form_batches" ADD CONSTRAINT "short_form_batches_rough_cut_id_fkey"
  FOREIGN KEY ("rough_cut_id") REFERENCES "rough_cuts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "short_form_batches" ADD CONSTRAINT "short_form_batches_source_version_id_fkey"
  FOREIGN KEY ("source_version_id") REFERENCES "video_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "short_form_batches" ADD CONSTRAINT "short_form_batches_requested_by_id_fkey"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "short_form_batches" ADD CONSTRAINT "short_form_batches_agent_run_id_fkey"
  FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "short_form_candidates" ADD CONSTRAINT "short_form_candidates_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "short_form_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "short_form_candidates" ADD CONSTRAINT "short_form_candidates_output_video_id_fkey"
  FOREIGN KEY ("output_video_id") REFERENCES "videos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
