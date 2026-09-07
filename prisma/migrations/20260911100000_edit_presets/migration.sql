CREATE TABLE "edit_presets" (
 "id" TEXT NOT NULL, "workspace_id" TEXT NOT NULL, "name" TEXT NOT NULL,
 "revision" INTEGER NOT NULL DEFAULT 1, "definition" JSONB NOT NULL,
 "archived" BOOLEAN NOT NULL DEFAULT false, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "edit_presets_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "edit_presets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "edit_presets_workspace_id_archived_idx" ON "edit_presets"("workspace_id", "archived");

ALTER TABLE "video_versions" ADD COLUMN "visual_evidence" JSONB;
ALTER TYPE "MediaJobKind" ADD VALUE 'ANALYZE_BROLL';
