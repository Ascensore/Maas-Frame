CREATE TYPE "CommentEditStatus" AS ENUM ('HUMAN', 'QUEUED', 'PLANNING', 'RENDERING', 'ACCEPTED', 'FAILED');
-- Existing outputs must be re-rendered once to establish exact provenance.
-- An active version may be an unrelated upload, so no inferred backfill is safe.
ALTER TABLE "rough_cuts" ADD COLUMN "rendered_version_id" TEXT;
ALTER TABLE "rough_cuts" ADD CONSTRAINT "rough_cuts_rendered_version_id_fkey"
  FOREIGN KEY ("rendered_version_id") REFERENCES "video_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "comment_edit_tasks" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "comment_id" TEXT NOT NULL,
  "status" "CommentEditStatus" NOT NULL DEFAULT 'HUMAN',
  "snapshot" JSONB,
  "agent_run_id" TEXT,
  "rough_cut_id" TEXT,
  "render_job_id" TEXT,
  "output_version_id" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "comment_edit_tasks_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "comment_edit_tasks_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "comment_edit_tasks_rough_cut_id_fkey" FOREIGN KEY ("rough_cut_id") REFERENCES "rough_cuts"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "comment_edit_tasks_output_version_id_fkey" FOREIGN KEY ("output_version_id") REFERENCES "video_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "comment_edit_tasks_comment_id_key" ON "comment_edit_tasks"("comment_id");
CREATE UNIQUE INDEX "comment_edit_tasks_agent_run_id_key" ON "comment_edit_tasks"("agent_run_id");
CREATE UNIQUE INDEX "comment_edit_tasks_rough_cut_id_key" ON "comment_edit_tasks"("rough_cut_id");
