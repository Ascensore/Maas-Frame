-- CreateEnum
CREATE TYPE "RoughCutLayout" AS ENUM ('MULTICAM', 'SEQUENTIAL', 'LINEAR');

-- AlterTable
ALTER TABLE "rough_cuts" ADD COLUMN "layout" "RoughCutLayout" NOT NULL DEFAULT 'MULTICAM';

-- AlterTable
ALTER TABLE "video_versions" ADD COLUMN "recorded_at" TIMESTAMP(3);
