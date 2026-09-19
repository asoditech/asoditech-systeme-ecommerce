-- Online/Offline unification, phases A–C — see docs/adr/0038-online-offline-unification.md.
--
-- STRICTLY ADDITIVE (expand + backfill; no contract step): new nullable
-- columns, new tables, new indexes. No column is dropped, renamed or
-- retyped; no existing row's stored quantity is touched.
--
--   A. Ledger hardening      inventory_movements.{onHandDelta,onHandAfter,unitCost,performedByName}
--   B. Catalog identity      products.reference + barcodes
--   C. Business channels     sales_channels, sales_channel_locations,
--                            product_sales_channels, user_channels,
--                            orders.salesChannelId
--
-- ONE physical stock: NOTHING here stores a quantity per channel. Channel
-- stock is derived from the physical locations a channel is mapped to.

-- CreateEnum
CREATE TYPE "SalesChannelKind" AS ENUM ('ONLINE', 'OFFLINE');

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "onHandAfter" INTEGER,
ADD COLUMN     "onHandDelta" INTEGER,
ADD COLUMN     "performedByName" TEXT,
ADD COLUMN     "unitCost" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "salesChannelId" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "reference" TEXT;

-- CreateTable
CREATE TABLE "sales_channels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "kind" "SalesChannelKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_channel_locations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "salesChannelId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_channel_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_sales_channels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "productId" TEXT NOT NULL,
    "salesChannelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_sales_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_channels" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "salesChannelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "user_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "barcodes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "code" TEXT NOT NULL,
    "productId" TEXT,
    "variationId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_channels_tenantId_kind_idx" ON "sales_channels"("tenantId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channels_tenantId_name_key" ON "sales_channels"("tenantId", "name");

-- CreateIndex
CREATE INDEX "sales_channel_locations_warehouseId_idx" ON "sales_channel_locations"("warehouseId");

-- CreateIndex
CREATE INDEX "sales_channel_locations_tenantId_idx" ON "sales_channel_locations"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_channel_locations_salesChannelId_warehouseId_key" ON "sales_channel_locations"("salesChannelId", "warehouseId");

-- CreateIndex
CREATE INDEX "product_sales_channels_salesChannelId_idx" ON "product_sales_channels"("salesChannelId");

-- CreateIndex
CREATE INDEX "product_sales_channels_tenantId_idx" ON "product_sales_channels"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_sales_channels_productId_salesChannelId_key" ON "product_sales_channels"("productId", "salesChannelId");

-- CreateIndex
CREATE INDEX "user_channels_salesChannelId_idx" ON "user_channels"("salesChannelId");

-- CreateIndex
CREATE INDEX "user_channels_tenantId_idx" ON "user_channels"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "user_channels_userId_salesChannelId_key" ON "user_channels"("userId", "salesChannelId");

-- CreateIndex
CREATE INDEX "barcodes_productId_idx" ON "barcodes"("productId");

-- CreateIndex
CREATE INDEX "barcodes_variationId_idx" ON "barcodes"("variationId");

-- CreateIndex
CREATE INDEX "barcodes_tenantId_idx" ON "barcodes"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "barcodes_tenantId_code_key" ON "barcodes"("tenantId", "code");

-- CreateIndex
CREATE INDEX "orders_salesChannelId_idx" ON "orders"("salesChannelId");

-- CreateIndex
CREATE INDEX "products_tenantId_reference_idx" ON "products"("tenantId", "reference");

-- AddForeignKey
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_locations" ADD CONSTRAINT "sales_channel_locations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_locations" ADD CONSTRAINT "sales_channel_locations_salesChannelId_fkey" FOREIGN KEY ("salesChannelId") REFERENCES "sales_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_channel_locations" ADD CONSTRAINT "sales_channel_locations_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sales_channels" ADD CONSTRAINT "product_sales_channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sales_channels" ADD CONSTRAINT "product_sales_channels_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_sales_channels" ADD CONSTRAINT "product_sales_channels_salesChannelId_fkey" FOREIGN KEY ("salesChannelId") REFERENCES "sales_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_salesChannelId_fkey" FOREIGN KEY ("salesChannelId") REFERENCES "sales_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "product_variations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_salesChannelId_fkey" FOREIGN KEY ("salesChannelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- DB-enforced invariants Prisma's schema DSL cannot express (same technique
-- as inventory_items_exactly_one_ref_check).
-- ---------------------------------------------------------------------------

-- A barcode identifies exactly ONE sellable unit: a Product XOR a
-- ProductVariation, never both, never neither. (`onDelete: Cascade` on both
-- FKs means a deleted owner takes its codes with it, so an XOR CHECK can
-- never be tripped by a delete — unlike order_items, whose FKs are SetNull.)
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_exactly_one_owner_check"
    CHECK (("productId" IS NOT NULL) <> ("variationId" IS NOT NULL));
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_code_not_blank_check"
    CHECK (length(btrim("code")) > 0);

-- At most one PRIMARY barcode per sellable unit.
CREATE UNIQUE INDEX "barcodes_one_primary_per_product" ON "barcodes"("productId") WHERE "isPrimary" AND "productId" IS NOT NULL;
CREATE UNIQUE INDEX "barcodes_one_primary_per_variation" ON "barcodes"("variationId") WHERE "isPrimary" AND "variationId" IS NOT NULL;

-- At most one default channel per tenant, and it must be ONLINE.
CREATE UNIQUE INDEX "sales_channels_one_default_per_tenant" ON "sales_channels"("tenantId") WHERE "isDefault";
ALTER TABLE "sales_channels" ADD CONSTRAINT "sales_channels_default_is_online_check"
    CHECK (NOT "isDefault" OR "kind" = 'ONLINE');

-- ---------------------------------------------------------------------------
-- RLS — identical policy shape to every other tenant-scoped table
-- (docs/adr/0026). Default-deny: no GUC set => zero rows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_channels','sales_channel_locations','product_sales_channels','user_channels','barcodes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "tenant_isolation" ON %I
      USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Deterministic backfill — preserves current behaviour exactly.
--
-- The backfill reads tenant-scoped tables (RLS is FORCEd), so it sets the
-- transaction-local bypass GUC first. Harmless when the migration role is a
-- superuser/BYPASSRLS role (as it is today); REQUIRED if it is a plain owner.
-- Every id is derived from the row it belongs to and every insert is
-- ON CONFLICT DO NOTHING, so re-running this section changes nothing.
-- ---------------------------------------------------------------------------
SELECT set_config('app.bypass_rls', 'on', true);

-- 1. One default ONLINE channel per existing tenant.
INSERT INTO "sales_channels" ("id", "tenantId", "name", "kind", "isActive", "isDefault", "createdAt", "updatedAt")
SELECT 'sch-online-' || t."id", t."id", 'En ligne', 'ONLINE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "tenants" t
ON CONFLICT DO NOTHING;

-- 2. Map it to exactly the locations the storefront stock push already
--    uses today: active ENTREPOTs (WooCommerce, ADR 0020 §9) and
--    Shopify-source locations (Shopify pushes per Location). MAGASIN
--    locations are deliberately NOT mapped — they never fed the storefront.
INSERT INTO "sales_channel_locations" ("id", "tenantId", "salesChannelId", "warehouseId", "createdAt")
SELECT 'scl-' || c."id" || '-' || w."id", c."tenantId", c."id", w."id", CURRENT_TIMESTAMP
FROM "sales_channels" c
JOIN "warehouses" w ON w."tenantId" = c."tenantId"
WHERE c."isDefault" AND w."isActive" AND (w."type" = 'ENTREPOT' OR w."source" = 'SHOPIFY')
ON CONFLICT DO NOTHING;

-- 3. Every existing delivery order belongs to the default ONLINE channel —
--    deterministic (every order to date is a delivery order, whatever its
--    `source`). Only NULLs are touched.
UPDATE "orders" o
SET "salesChannelId" = c."id"
FROM "sales_channels" c
WHERE c."tenantId" = o."tenantId" AND c."isDefault" AND o."salesChannelId" IS NULL;

-- 4. Every existing product was sellable through the delivery flow, so it
--    is available on the default ONLINE channel.
INSERT INTO "product_sales_channels" ("id", "tenantId", "productId", "salesChannelId", "createdAt")
SELECT 'psc-' || p."id" || '-' || c."id", p."tenantId", p."id", c."id", CURRENT_TIMESTAMP
FROM "products" p
JOIN "sales_channels" c ON c."tenantId" = p."tenantId" AND c."isDefault"
ON CONFLICT DO NOTHING;

-- 5. Preserve current access: every non-OWNER/non-ADMIN user could already
--    see the delivery business yesterday, so they keep the ONLINE channel.
--    OWNER/ADMIN need no row (tenant-wide by role).
INSERT INTO "user_channels" ("id", "tenantId", "userId", "salesChannelId", "createdAt")
SELECT 'uc-' || u."id" || '-' || c."id", u."tenantId", u."id", c."id", CURRENT_TIMESTAMP
FROM "users" u
JOIN "sales_channels" c ON c."tenantId" = u."tenantId" AND c."isDefault"
WHERE u."role" NOT IN ('OWNER', 'ADMIN')
ON CONFLICT DO NOTHING;
