CREATE TYPE "CommentEditRevisionStatus" AS ENUM ('READY', 'ACCEPTED', 'FAILED');

CREATE TABLE "comment_edit_revisions" (
  "id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "agent_run_id" TEXT NOT NULL,
  "status" "CommentEditRevisionStatus" NOT NULL,
  "instruction" TEXT,
  "adjustment" TEXT,
  "changes" JSONB,
  "removed_seconds" DOUBLE PRECISION,
  "output_version_id" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "comment_edit_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "comment_edit_revisions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "comment_edit_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "comment_edit_revisions_output_version_id_fkey" FOREIGN KEY ("output_version_id") REFERENCES "video_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "comment_edit_revisions_task_id_agent_run_id_key" ON "comment_edit_revisions"("task_id", "agent_run_id");
CREATE INDEX "comment_edit_revisions_task_id_created_at_idx" ON "comment_edit_revisions"("task_id", "created_at");
