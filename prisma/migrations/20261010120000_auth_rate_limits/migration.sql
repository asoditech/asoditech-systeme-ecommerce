-- Authentication rate limiting (Batch 1A hardening — src/lib/security/rate-limit.ts).
-- Additive only: one new, empty, global table. Nothing existing is touched.
--
-- Global/ephemeral like "sessions": no tenantId and no RLS — buckets are
-- evaluated before any tenant is known. One row per active bucket (never one
-- per request); keys hold only an HMAC of the email / IP / user id.
-- Expired rows are swept in bounded batches through the window_end index.
--
-- Grants: the runtime role (asoditech_app) receives SELECT/INSERT/UPDATE/DELETE
-- through scripts/provision-production-role.sql's ALTER DEFAULT PRIVILEGES, as
-- long as this migration runs as the same migration role. If it does not, the
-- limiter fails open for login/reset (logged as "[rate-limit] backend_error")
-- and fails CLOSED for the platform unlock.

-- CreateTable
CREATE TABLE "auth_rate_limits" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "auth_rate_limits_window_end_idx" ON "auth_rate_limits"("window_end");
