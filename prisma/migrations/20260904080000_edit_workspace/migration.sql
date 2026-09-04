-- AlterEnum
ALTER TYPE "MediaJobKind" ADD VALUE 'IMPORT_DRIVE';
ALTER TYPE "MediaJobKind" ADD VALUE 'MATERIALIZE_ROUGH_CUT';

-- AlterTable
ALTER TABLE "rough_cuts" ADD COLUMN "output_video_id" TEXT;

-- CreateIndex
CREATE INDEX "rough_cuts_output_video_id_idx" ON "rough_cuts"("output_video_id");

-- AddForeignKey
ALTER TABLE "rough_cuts" ADD CONSTRAINT "rough_cuts_output_video_id_fkey" FOREIGN KEY ("output_video_id") REFERENCES "videos"("id") ON DELETE SET NULL ON UPDATE CASCADE;
