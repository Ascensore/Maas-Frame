-- A comment used to hold at most one image, in "comments"."imageUrl". Screenshots
-- arrive in batches, so the images move into their own table and the old column
-- stays as a pointer to the first one for readers that have not been updated.
CREATE TABLE "comment_images" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_images_pkey" PRIMARY KEY ("id")
);

-- An uploaded file belongs to exactly one comment, which is what the old
-- "comments_imageUrl_key" guaranteed. Reference checks before an R2 delete
-- rely on it.
CREATE UNIQUE INDEX "comment_images_url_key" ON "comment_images"("url");
CREATE INDEX "comment_images_commentId_position_idx" ON "comment_images"("commentId", "position");

ALTER TABLE "comment_images" ADD CONSTRAINT "comment_images_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing single attachments become the first image of their comment, so the
-- new table is the complete list from the first read after this migration.
INSERT INTO "comment_images" ("id", "url", "position", "commentId", "createdAt")
SELECT gen_random_uuid()::text, "imageUrl", 0, "id", "createdAt"
FROM "comments"
WHERE "imageUrl" IS NOT NULL;
