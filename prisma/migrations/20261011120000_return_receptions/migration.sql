-- P3 — Returns receiving & inspection workspace (/livraison/retours).
-- See the ReturnReception comment block in prisma/schema.prisma.
--
-- Additive only: one new enum, one new, empty tenant-scoped table, and one
-- new index on "shipments". No existing row, column or constraint is
-- touched; existing physical-return history (order_returns /
-- order_return_lines) stays exactly as it is.
--
-- Generated with `prisma migrate diff --from-schema-datamodel <pre-P3 schema>
-- --to-schema-datamodel prisma/schema.prisma --script` (offline, no database),
-- then hand-edited to add what Prisma's DSL can't express on the 6.19 line:
--   1. the partial unique index "at most ONE reception awaiting inspection
--      per shipment" (precedent: barcodes_one_primary_per_product),
--   2. a CHECK tying the status to the inspection link (precedent:
--      order_return_lines_quantities_check),
--   3. the RLS policy — identical shape to every other tenant-scoped table
--      (docs/adr/0026; precedent: order_returns' own migration).
--
-- Grants: the runtime role receives privileges on the new table through
-- the existing ALTER DEFAULT PRIVILEGES, as long as this migration runs as
-- the same migration role (same note as 20261010120000_auth_rate_limits).

-- CreateEnum
CREATE TYPE "ReturnReceptionStatus" AS ENUM ('A_INSPECTER', 'INSPECTE');

-- CreateTable
CREATE TABLE "return_receptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "shipmentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "ReturnReceptionStatus" NOT NULL DEFAULT 'A_INSPECTER',
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inspectedById" TEXT,
    "inspectedAt" TIMESTAMP(3),
    "orderReturnId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_receptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "return_receptions_orderReturnId_key" ON "return_receptions"("orderReturnId");

-- CreateIndex
CREATE INDEX "return_receptions_shipmentId_idx" ON "return_receptions"("shipmentId");

-- CreateIndex
CREATE INDEX "return_receptions_orderId_idx" ON "return_receptions"("orderId");

-- CreateIndex
CREATE INDEX "return_receptions_warehouseId_idx" ON "return_receptions"("warehouseId");

-- CreateIndex
CREATE INDEX "return_receptions_tenantId_status_idx" ON "return_receptions"("tenantId", "status");

-- CreateIndex
CREATE INDEX "shipments_tenantId_trackingNumber_idx" ON "shipments"("tenantId", "trackingNumber");

-- AddForeignKey
ALTER TABLE "return_receptions" ADD CONSTRAINT "return_receptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receptions" ADD CONSTRAINT "return_receptions_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receptions" ADD CONSTRAINT "return_receptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receptions" ADD CONSTRAINT "return_receptions_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receptions" ADD CONSTRAINT "return_receptions_orderReturnId_fkey" FOREIGN KEY ("orderReturnId") REFERENCES "order_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receptions" ADD CONSTRAINT "return_receptions_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_receptions" ADD CONSTRAINT "return_receptions_inspectedById_fkey" FOREIGN KEY ("inspectedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one reception awaiting inspection per shipment — the DB-level
-- guard against a duplicate scan / two operators receiving the same parcel
-- concurrently (the loser gets P2002 → « déjà réceptionné »). An INSPECTE
-- reception no longer blocks a later reception of the units that were not
-- in the parcel (they stay returnable — the per-item ceiling still applies).
CREATE UNIQUE INDEX "return_receptions_one_pending_per_shipment" ON "return_receptions"("shipmentId") WHERE "status" = 'A_INSPECTER';

-- CheckConstraint: A_INSPECTER has no inspection link; INSPECTE always has
-- both its OrderReturn and its inspection timestamp.
ALTER TABLE "return_receptions"
  ADD CONSTRAINT "return_receptions_status_check"
  CHECK (
    ("status" = 'A_INSPECTER' AND "orderReturnId" IS NULL AND "inspectedAt" IS NULL)
    OR ("status" = 'INSPECTE' AND "orderReturnId" IS NOT NULL AND "inspectedAt" IS NOT NULL)
  );

-- RLS — identical policy shape to every other tenant-scoped table.
ALTER TABLE "return_receptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "return_receptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "return_receptions"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
