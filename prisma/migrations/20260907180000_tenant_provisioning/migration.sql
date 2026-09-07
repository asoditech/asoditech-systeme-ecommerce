-- Phase 5 — tenant provisioning & user management. See
-- docs/adr/0027-tenant-provisioning.md.
--
-- 1. UserRole.SALES -> UserRole.CONFIRMATION. Hand-written as a single
--    `ALTER TYPE … RENAME VALUE` instead of the auto-generated "create a
--    new enum type, cast every row through ::text, swap, drop the old
--    type" Prisma normally emits for an enum diff — that generic approach
--    treats a rename as "remove SALES, add CONFIRMATION" and its
--    `USING ("role"::text::"UserRole_new")` cast would FAIL outright for
--    every existing SALES row (not a member of the new type). RENAME VALUE
--    is exactly the right primitive for a pure rename: it updates the
--    label in place, so every existing row's value (stored as the enum's
--    internal ordinal, never the text) is completely unaffected, and so is
--    the column's DEFAULT (also stored by ordinal, not text) — no DROP/SET
--    DEFAULT needed either, unlike the generic diff.
-- 2. `users.isPlatformAdmin` — the /platform cross-tenant area's gate.
-- 3. `invitations` / `password_reset_tokens` — tenant-scoped (RLS +
--    Phase 2-4 app-level scoping apply automatically, same as every other
--    tenant-owned table), `tokenHash` globally unique on both (the lookup
--    key BEFORE any tenant is known — see docs/adr/0027).
-- 4. Backfill: the bootstrap tenant's existing OWNER account(s) become
--    platform admins — until real platform provisioning exists, "the
--    bootstrap tenant's owner" IS the platform operator (docs/adr/0027).

-- Step 1 — UserRole.SALES -> UserRole.CONFIRMATION.
ALTER TYPE "UserRole" RENAME VALUE 'SALES' TO 'CONFIRMATION';

-- Step 2 — platform-admin flag.
ALTER TABLE "users" ADD COLUMN "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false;

-- Step 3 — invitations + password_reset_tokens.
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invitedById" TEXT,
    "acceptedById" TEXT,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");
CREATE UNIQUE INDEX "invitations_acceptedById_key" ON "invitations"("acceptedById");
CREATE INDEX "invitations_tenantId_email_idx" ON "invitations"("tenantId", "email");
CREATE INDEX "invitations_tenantId_status_idx" ON "invitations"("tenantId", "status");

CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");
CREATE INDEX "password_reset_tokens_tenantId_idx" ON "password_reset_tokens"("tenantId");
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptedById_fkey" FOREIGN KEY ("acceptedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 4 — RLS on both new tenant-scoped tables, identical policy shape to
-- every other one (docs/adr/0026-multi-tenant-rls.md).
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invitations"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "password_reset_tokens"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

-- Step 5 — the bootstrap tenant's existing OWNER(s) become platform admins.
UPDATE "users" SET "isPlatformAdmin" = true WHERE "tenantId" = 'default' AND "role" = 'OWNER';
