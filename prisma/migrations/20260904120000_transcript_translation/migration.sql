-- AlterTable
ALTER TABLE "transcripts" ALTER COLUMN "language" SET DEFAULT 'und';
ALTER TABLE "transcripts" ADD COLUMN "translation_language" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "translation_status" "TranscriptStatus";
ALTER TABLE "transcripts" ADD COLUMN "translation_error" TEXT;
ALTER TABLE "transcripts" ADD COLUMN "translated_texts" JSONB;
