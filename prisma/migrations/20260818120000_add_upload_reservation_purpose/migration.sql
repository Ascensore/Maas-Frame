-- AlterTable: record what each hold was opened for, so a reservation can only be
-- consumed by the flow that opened it. Without this a caller who could name a
-- reservation id could drop any of their own holds through whichever finalize
-- route was cheapest, which defeats the point of holding one at all.
--
-- Rows that predate this column get 'LEGACY', which matches no finalize route.
-- Those uploads fall through to the in-transaction quota check instead, and the
-- rows lapse on their own TTL within the hour.
ALTER TABLE "upload_reservations" ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "upload_reservations" ALTER COLUMN "purpose" DROP DEFAULT;
