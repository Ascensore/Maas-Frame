-- AlterTable: opt-in only — existing projects stay unwatermarked until enabled.
ALTER TABLE "projects" ADD COLUMN "watermarkReviews" BOOLEAN NOT NULL DEFAULT false;
