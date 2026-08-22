-- Subtitle tracks hang off a version, not off the video: re-editing a cut shifts
-- every cue, so a track attached to the parent would be wrong for every version
-- but the one it was written against.
CREATE TABLE "video_subtitles" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "billedUserId" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_subtitles_pkey" PRIMARY KEY ("id")
);

-- One stored object belongs to exactly one row, so the reference check that runs
-- before an object delete cannot be fooled by a second row pointing at the file.
CREATE UNIQUE INDEX "video_subtitles_sourceUrl_key" ON "video_subtitles"("sourceUrl");

-- Re-uploading a language replaces the track rather than stacking a second one,
-- which would leave the player with two tracks labelled the same.
CREATE UNIQUE INDEX "video_subtitles_versionId_language_key" ON "video_subtitles"("versionId", "language");

CREATE INDEX "video_subtitles_versionId_idx" ON "video_subtitles"("versionId");

-- The storage quota sums this column per billed user on every upload.
CREATE INDEX "video_subtitles_billedUserId_idx" ON "video_subtitles"("billedUserId");

ALTER TABLE "video_subtitles" ADD CONSTRAINT "video_subtitles_versionId_fkey"
    FOREIGN KEY ("versionId") REFERENCES "video_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "video_subtitles" ADD CONSTRAINT "video_subtitles_billedUserId_fkey"
    FOREIGN KEY ("billedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "video_subtitles" ADD CONSTRAINT "video_subtitles_uploadedByUserId_fkey"
    FOREIGN KEY ("uploadedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
