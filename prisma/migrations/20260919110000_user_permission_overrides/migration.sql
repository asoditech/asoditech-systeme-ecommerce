-- Per-user permission overrides — see docs/adr/0039-permission-overrides-and-scope.md.
--
-- STRICTLY ADDITIVE: one new table + one enum. No existing table or row is
-- touched, and NO backfill is needed — with zero override rows every user's
-- effective permissions are EXACTLY their role's (the current behaviour).
--
--   effective = (rolePermissions ∪ GRANTs) − DENYs   (DENY always wins)

-- CreateEnum
CREATE TYPE "PermissionEffect" AS ENUM ('GRANT', 'DENY');

-- CreateTable
CREATE TABLE "user_permission_overrides" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" "PermissionEffect" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_permission_overrides_tenantId_idx" ON "user_permission_overrides"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_permission_overrides_userId_permission_key" ON "user_permission_overrides"("userId", "permission");

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- RLS — identical policy shape to every other tenant-scoped table (docs/adr/0026).
ALTER TABLE "user_permission_overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_permission_overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "user_permission_overrides"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
