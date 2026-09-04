-- CreateEnum
CREATE TYPE "EditorialProjectType" AS ENUM ('ASCENSORE', 'TALKING_HEAD', 'INTERVIEW');

-- CreateTable
CREATE TABLE "editorial_briefs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "project_type" "EditorialProjectType" NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "editorial_briefs_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "folders" ADD COLUMN "editorial_brief_id" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "editorialBriefId" TEXT;

-- AlterTable
ALTER TABLE "rough_cuts" ADD COLUMN "brief_id" TEXT,
ADD COLUMN "brief_snapshot" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "editorial_briefs_workspace_id_name_key" ON "editorial_briefs"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "editorial_briefs_workspace_id_project_type_idx" ON "editorial_briefs"("workspace_id", "project_type");

-- CreateIndex
CREATE INDEX "folders_editorial_brief_id_idx" ON "folders"("editorial_brief_id");

-- CreateIndex
CREATE INDEX "projects_editorialBriefId_idx" ON "projects"("editorialBriefId");

-- CreateIndex
CREATE INDEX "rough_cuts_brief_id_idx" ON "rough_cuts"("brief_id");

-- AddForeignKey
ALTER TABLE "editorial_briefs" ADD CONSTRAINT "editorial_briefs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_editorial_brief_id_fkey" FOREIGN KEY ("editorial_brief_id") REFERENCES "editorial_briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_editorialBriefId_fkey" FOREIGN KEY ("editorialBriefId") REFERENCES "editorial_briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_cuts" ADD CONSTRAINT "rough_cuts_brief_id_fkey" FOREIGN KEY ("brief_id") REFERENCES "editorial_briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
