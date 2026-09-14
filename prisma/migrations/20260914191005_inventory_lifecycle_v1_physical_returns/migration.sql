-- Inventory & Order Lifecycle v1 — physical returns.
-- See docs/adr/0036-inventory-single-source-of-truth.md.
--
-- Hand-edited after `prisma migrate dev --create-only` to add:
--   1. one raw-SQL CHECK constraint Prisma's DSL can't express on the
--      6.19 line (quantitySellable/quantityDamaged bounds, same precedent
--      as stock_transfer_lines_quantities_check) and
--   2. RLS policies on the two new tenant-scoped tables — same policy
--      shape as every other tenant-scoped table (docs/adr/0026), same
--      precedent as support_tickets' own migration.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'INCOHERENCE_WORKFLOW';

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "orderReturnId" TEXT;

-- CreateTable
CREATE TABLE "order_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "orderId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_return_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "orderReturnId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "quantitySellable" INTEGER NOT NULL DEFAULT 0,
    "quantityDamaged" INTEGER NOT NULL DEFAULT 0,
    "warehouseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_return_lines_pkey" PRIMARY KEY ("id")
);

-- CheckConstraint: both quantities are non-negative, and at least one is
-- positive — a line always represents a real physically-received quantity.
ALTER TABLE "order_return_lines"
  ADD CONSTRAINT "order_return_lines_quantities_check"
  CHECK (
    "quantitySellable" >= 0
    AND "quantityDamaged" >= 0
    AND ("quantitySellable" > 0 OR "quantityDamaged" > 0)
  );

-- CreateIndex
CREATE INDEX "order_returns_orderId_idx" ON "order_returns"("orderId");

-- CreateIndex
CREATE INDEX "order_returns_tenantId_idx" ON "order_returns"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "order_returns_orderId_idempotencyKey_key" ON "order_returns"("orderId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "order_return_lines_orderReturnId_idx" ON "order_return_lines"("orderReturnId");

-- CreateIndex
CREATE INDEX "order_return_lines_orderItemId_idx" ON "order_return_lines"("orderItemId");

-- CreateIndex
CREATE INDEX "order_return_lines_warehouseId_idx" ON "order_return_lines"("warehouseId");

-- CreateIndex
CREATE INDEX "order_return_lines_tenantId_idx" ON "order_return_lines"("tenantId");

-- CreateIndex
CREATE INDEX "inventory_movements_orderReturnId_idx" ON "inventory_movements"("orderReturnId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_orderReturnId_fkey" FOREIGN KEY ("orderReturnId") REFERENCES "order_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_returns" ADD CONSTRAINT "order_returns_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_orderReturnId_fkey" FOREIGN KEY ("orderReturnId") REFERENCES "order_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_return_lines" ADD CONSTRAINT "order_return_lines_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS — identical policy shape to every other tenant-scoped table.
ALTER TABLE "order_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_returns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_returns"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));

ALTER TABLE "order_return_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_return_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_return_lines"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
