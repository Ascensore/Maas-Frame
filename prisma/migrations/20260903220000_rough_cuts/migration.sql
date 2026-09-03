-- AlterEnum
ALTER TYPE "MediaJobKind" ADD VALUE 'DIARIZE';
ALTER TYPE "MediaJobKind" ADD VALUE 'ASSEMBLE_ROUGH_CUT';

-- CreateEnum
CREATE TYPE "RoughCutStatus" AS ENUM ('PENDING', 'RUNNING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "RoughCutOverlap" AS ENUM ('WIDE', 'HOLD', 'SPEAKER');

-- CreateEnum
CREATE TYPE "RoughCutSyncStrategy" AS ENUM ('AUTO', 'TIMECODE', 'WAVEFORM');

-- CreateTable
CREATE TABLE "rough_cut_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "min_shot_seconds" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "safety_pause_seconds" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "max_shot_seconds" DOUBLE PRECISION,
    "overlap_behaviour" "RoughCutOverlap" NOT NULL DEFAULT 'WIDE',
    "handle_frames" INTEGER NOT NULL DEFAULT 0,
    "wide_camera_role" TEXT NOT NULL DEFAULT 'WIDE',
    "camera_role_metadata_key" TEXT NOT NULL DEFAULT 'camera',
    "sync_strategy" "RoughCutSyncStrategy" NOT NULL DEFAULT 'AUTO',
    "media_path_prefix" TEXT NOT NULL DEFAULT './media/',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rough_cut_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rough_cuts" (
    "id" TEXT NOT NULL,
    "status" "RoughCutStatus" NOT NULL DEFAULT 'PENDING',
    "project_id" TEXT NOT NULL,
    "folder_id" TEXT,
    "profile_id" TEXT,
    "requested_by_id" TEXT NOT NULL,
    "frame_rate_num" INTEGER,
    "frame_rate_den" INTEGER,
    "drop_frame" BOOLEAN NOT NULL DEFAULT false,
    "profile_snapshot" JSONB NOT NULL,
    "sync_report" JSONB,
    "decisions" JSONB,
    "warnings" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rough_cuts_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "folders" ADD COLUMN "rough_cut_profile_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "rough_cut_profiles_workspace_id_name_key" ON "rough_cut_profiles"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "rough_cut_profiles_workspace_id_idx" ON "rough_cut_profiles"("workspace_id");

-- CreateIndex
CREATE INDEX "rough_cuts_project_id_folder_id_created_at_idx" ON "rough_cuts"("project_id", "folder_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "rough_cuts_status_created_at_idx" ON "rough_cuts"("status", "created_at");

-- CreateIndex
CREATE INDEX "folders_rough_cut_profile_id_idx" ON "folders"("rough_cut_profile_id");

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_rough_cut_profile_id_fkey" FOREIGN KEY ("rough_cut_profile_id") REFERENCES "rough_cut_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_cut_profiles" ADD CONSTRAINT "rough_cut_profiles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_cuts" ADD CONSTRAINT "rough_cuts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_cuts" ADD CONSTRAINT "rough_cuts_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_cuts" ADD CONSTRAINT "rough_cuts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "rough_cut_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_cuts" ADD CONSTRAINT "rough_cuts_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
