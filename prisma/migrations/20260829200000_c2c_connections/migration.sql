-- AlterTable
CREATE TABLE "c2c_connections" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "folder_id" TEXT,
    "created_by_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_prefix" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "c2c_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "c2c_connections_token_hash_key" ON "c2c_connections"("token_hash");
CREATE INDEX "c2c_connections_project_id_idx" ON "c2c_connections"("project_id");
CREATE INDEX "c2c_connections_created_by_id_idx" ON "c2c_connections"("created_by_id");

ALTER TABLE "c2c_connections" ADD CONSTRAINT "c2c_connections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "c2c_connections" ADD CONSTRAINT "c2c_connections_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "c2c_connections" ADD CONSTRAINT "c2c_connections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
