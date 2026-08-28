-- CreateEnum
CREATE TYPE "VideoProxyStatus" AS ENUM ('NONE', 'PENDING', 'RUNNING', 'READY', 'SKIPPED', 'FAILED');

-- AlterEnum
ALTER TYPE "MediaJobKind" ADD VALUE 'TRANSCODE_PROXY';

-- AlterTable
ALTER TABLE "video_versions"
  ADD COLUMN "proxy_status" "VideoProxyStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "proxy_url" TEXT;
