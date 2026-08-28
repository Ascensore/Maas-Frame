-- CreateEnum
CREATE TYPE "MediaJobKind" AS ENUM ('PROBE_MEDIA', 'EXTRACT_AUDIO', 'TRANSCRIBE');

-- CreateEnum
CREATE TYPE "MediaJobStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TranscriptStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "video_versions"
  ADD COLUMN "frame_rate_num" INTEGER,
  ADD COLUMN "frame_rate_den" INTEGER,
  ADD COLUMN "drop_frame" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "start_timecode" TEXT,
  ADD COLUMN "duration_frames" INTEGER;

-- AlterTable
ALTER TABLE "comments" ADD COLUMN "timestampFrame" INTEGER;

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_jobs" (
    "id" TEXT NOT NULL,
    "kind" "MediaJobKind" NOT NULL,
    "status" "MediaJobStatus" NOT NULL DEFAULT 'PENDING',
    "version_id" TEXT NOT NULL,
    "payload" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "provider" TEXT NOT NULL,
    "status" "TranscriptStatus" NOT NULL DEFAULT 'PENDING',
    "search_text" TEXT NOT NULL DEFAULT '',
    "search_vector" tsvector,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_segments" (
    "id" TEXT NOT NULL,
    "transcript_id" TEXT NOT NULL,
    "start_sec" DOUBLE PRECISION NOT NULL,
    "end_sec" DOUBLE PRECISION NOT NULL,
    "speaker" TEXT,
    "text" TEXT NOT NULL,
    "words" JSONB NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sequence_links" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "nle" TEXT NOT NULL,
    "sequence_name" TEXT NOT NULL,
    "start_timecode" TEXT NOT NULL,
    "frame_rate_num" INTEGER NOT NULL,
    "frame_rate_den" INTEGER NOT NULL,
    "drop_frame" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sequence_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "api_tokens_userId_idx" ON "api_tokens"("userId");

-- CreateIndex
CREATE INDEX "media_jobs_status_created_at_idx" ON "media_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "media_jobs_version_id_kind_idx" ON "media_jobs"("version_id", "kind");

-- CreateIndex
CREATE INDEX "transcripts_version_id_idx" ON "transcripts"("version_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_version_id_language_key" ON "transcripts"("version_id", "language");

-- CreateIndex
CREATE INDEX "transcript_segments_transcript_id_position_idx" ON "transcript_segments"("transcript_id", "position");

-- CreateIndex
CREATE INDEX "sequence_links_version_id_idx" ON "sequence_links"("version_id");

-- CreateIndex
CREATE UNIQUE INDEX "sequence_links_user_id_version_id_nle_key" ON "sequence_links"("user_id", "version_id", "nle");

-- CreateIndex
CREATE INDEX "transcripts_search_vector_idx" ON "transcripts" USING GIN ("search_vector");

-- AddForeignKey
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_jobs" ADD CONSTRAINT "media_jobs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "video_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "video_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep search_vector in sync with search_text so full-text search does not
-- depend on the application writing both columns.
CREATE OR REPLACE FUNCTION transcripts_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', coalesce(NEW.search_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transcripts_search_vector_trigger
BEFORE INSERT OR UPDATE OF search_text ON transcripts
FOR EACH ROW
EXECUTE FUNCTION transcripts_search_vector_update();
