-- Tenant business mode — see docs/adr/0041-tenant-business-mode.md.
--
-- STRICTLY ADDITIVE: one enum + one NOT NULL column WITH A DEFAULT on tenants
-- (a metadata-only change in Postgres; no table rewrite, no row-by-row update).
--
-- The default is ONLINE_ONLY = the pre-existing product, so EVERY tenant that
-- exists when this runs (including the bootstrap tenant) becomes ONLINE_ONLY and
-- behaves exactly as it did before: all Offline capabilities stay off. A
-- platform admin promotes a tenant to ONLINE_AND_OFFLINE explicitly, from
-- /platform. No backfill is needed and none is done — a tenant's mode is never
-- guessed from its data.

-- CreateEnum
CREATE TYPE "TenantBusinessMode" AS ENUM ('ONLINE_ONLY', 'ONLINE_AND_OFFLINE');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "businessMode" "TenantBusinessMode" NOT NULL DEFAULT 'ONLINE_ONLY';

