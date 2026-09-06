-- Several explicitly queued comments can share one plan, render and reviewed output.
DROP INDEX "comment_edit_tasks_agent_run_id_key";
DROP INDEX "comment_edit_tasks_rough_cut_id_key";
CREATE INDEX "comment_edit_tasks_agent_run_id_idx" ON "comment_edit_tasks"("agent_run_id");
CREATE INDEX "comment_edit_tasks_rough_cut_id_idx" ON "comment_edit_tasks"("rough_cut_id");
