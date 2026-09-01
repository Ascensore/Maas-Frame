-- CreateEnum
CREATE TYPE "CommentSource" AS ENUM ('HUMAN', 'AGENT');

-- CreateEnum
CREATE TYPE "AgentRunKind" AS ENUM ('REVIEW', 'EDIT');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "version_id" TEXT NOT NULL,
    "kind" "AgentRunKind" NOT NULL,
    "agent_slug" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'PENDING',
    "model" TEXT NOT NULL,
    "triggered_by_id" TEXT,
    "payload" JSONB,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_status_created_at_idx" ON "agent_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_version_id_status_idx" ON "agent_runs"("version_id", "status");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "video_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "comments" ADD COLUMN "source" "CommentSource" NOT NULL DEFAULT 'HUMAN';
ALTER TABLE "comments" ADD COLUMN "agentRunId" TEXT;
ALTER TABLE "comments" ADD COLUMN "agentSlug" TEXT;
ALTER TABLE "comments" ADD COLUMN "agentFingerprint" TEXT;

-- CreateIndex
CREATE INDEX "comments_agentRunId_idx" ON "comments"("agentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "comments_agentRunId_agentFingerprint_key" ON "comments"("agentRunId", "agentFingerprint");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
