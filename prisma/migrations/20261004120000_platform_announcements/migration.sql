-- Platform announcement bar (docs/adr/0059).
-- Additive only: one new enum + one new PLATFORM-level table (no tenantId,
-- like "plans" — so no RLS policy: every tenant reads the same broadcast;
-- writes are restricted in the application to platform admins). No backfill.
-- The runtime role gets DML on it through the existing ALTER DEFAULT
-- PRIVILEGES (scripts/provision-production-role.sql) — nothing to re-provision.

-- CreateEnum
CREATE TYPE "AnnouncementType" AS ENUM ('INFO', 'MAINTENANCE', 'NEW_FEATURE');

-- CreateTable
CREATE TABLE "platform_announcements" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "AnnouncementType" NOT NULL DEFAULT 'INFO',
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "actionLabel" TEXT,
    "actionUrl" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_announcements_isPublished_idx" ON "platform_announcements"("isPublished");
