-- AlterTable
ALTER TABLE "videos" ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
