-- CreateEnum
CREATE TYPE "ReviewKind" AS ENUM ('VIDEO', 'IMAGE', 'PDF', 'AUDIO');

-- AlterTable
ALTER TABLE "videos" ADD COLUMN "kind" "ReviewKind" NOT NULL DEFAULT 'VIDEO';
