-- AlterTable
-- A delayed media job: the worker publishes PENDING rows only once run_after
-- has passed. NULL keeps the previous behaviour (publish as soon as seen).
ALTER TABLE "media_jobs" ADD COLUMN "run_after" TIMESTAMP(3);
