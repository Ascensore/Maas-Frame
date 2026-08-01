-- CreateEnum
CREATE TYPE "AcquisitionChannel" AS ENUM ('DIRECT', 'GITHUB', 'YOUTUBE', 'GOOGLE', 'REVIEW_LINK', 'REFERRAL', 'OUTBOUND', 'COMMUNITY', 'OTHER');

-- CreateEnum
CREATE TYPE "AnalyticsEventName" AS ENUM ('LANDING_VIEW', 'CTA_CLICKED', 'SIGNUP_STARTED', 'SIGNUP_COMPLETED', 'EMAIL_VERIFIED', 'TRIAL_STARTED', 'WORKSPACE_CREATED', 'PROJECT_CREATED', 'VIDEO_ADDED', 'SHARE_LINK_CREATED', 'FIRST_GUEST_COMMENT', 'APPROVAL_COMPLETED', 'CHECKOUT_STARTED', 'SUBSCRIPTION_STARTED', 'SUBSCRIPTION_CANCELED', 'SUBSCRIPTION_REACTIVATED');

-- CreateTable
CREATE TABLE "acquisition_touches" (
    "id" TEXT NOT NULL,
    "anonymous_id" TEXT NOT NULL,
    "channel" "AcquisitionChannel" NOT NULL,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "referrer_host" TEXT,
    "landing_path" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acquisition_touches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_acquisitions" (
    "user_id" TEXT NOT NULL,
    "anonymous_id" TEXT,
    "channel" "AcquisitionChannel" NOT NULL DEFAULT 'DIRECT',
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "referrer_host" TEXT,
    "landing_path" TEXT,
    "self_reported" "AcquisitionChannel",
    "self_reported_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_acquisitions_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" TEXT NOT NULL,
    "name" "AnalyticsEventName" NOT NULL,
    "user_id" TEXT,
    "anonymous_id" TEXT,
    "channel" "AcquisitionChannel",
    "dedupe_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acquisition_touches_anonymous_id_key" ON "acquisition_touches"("anonymous_id");

-- CreateIndex
CREATE INDEX "acquisition_touches_channel_created_at_idx" ON "acquisition_touches"("channel", "created_at");

-- CreateIndex
CREATE INDEX "acquisition_touches_created_at_idx" ON "acquisition_touches"("created_at");

-- CreateIndex
CREATE INDEX "user_acquisitions_channel_created_at_idx" ON "user_acquisitions"("channel", "created_at");

-- CreateIndex
CREATE INDEX "user_acquisitions_anonymous_id_idx" ON "user_acquisitions"("anonymous_id");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_events_dedupe_key_key" ON "analytics_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "analytics_events_name_occurred_at_idx" ON "analytics_events"("name", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_user_id_occurred_at_idx" ON "analytics_events"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_channel_name_occurred_at_idx" ON "analytics_events"("channel", "name", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_anonymous_id_idx" ON "analytics_events"("anonymous_id");

-- AddForeignKey
ALTER TABLE "user_acquisitions" ADD CONSTRAINT "user_acquisitions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
