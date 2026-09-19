-- Suppliers & receptions (phase E) + offline sales (phase F) — see
-- docs/adr/0040-offline-sales-and-receptions.md.
--
-- STRICTLY ADDITIVE: new tables, two enums, three nullable columns on
-- inventory_movements (document FKs), three counters on tenants (DEFAULT 1).
-- No existing column is altered or dropped and no existing row is touched, so
-- NO backfill is needed: every new table starts empty, and every existing
-- movement keeps NULL document references (provenance is never invented).
--
--   E. Supplier, Reception(+Line), SupplierPayment   — physical stock ENTERING
--      the business; the canonical RECEPTION movement is written on validation.
--   F. Sale(+Line), SalePayment, SaleReturn(+Line)   — an in-store transaction,
--      SEPARATE from the delivery Order; decrements physical stock through the
--      same canonical primitive.
--
-- ONE physical stock: nothing here stores a stock quantity except as a
-- document; the inventory movement remains authoritative.

-- CreateEnum
CREATE TYPE "CashPaymentMethod" AS ENUM ('ESPECES', 'CARTE', 'VIREMENT', 'CHEQUE', 'AUTRE');

-- CreateEnum
CREATE TYPE "ReceptionStatus" AS ENUM ('BROUILLON', 'VALIDEE', 'ANNULEE');

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "receptionLineId" TEXT,
ADD COLUMN     "saleId" TEXT,
ADD COLUMN     "saleReturnId" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "nextReceptionNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "nextSaleNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "nextSaleReturnNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receptions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "receptionNumber" SERIAL NOT NULL,
    "displayNumber" INTEGER,
    "supplierId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "ReceptionStatus" NOT NULL DEFAULT 'BROUILLON',
    "receptionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supplierReference" TEXT,
    "notes" TEXT,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdByName" TEXT,
    "validatedById" TEXT,
    "validatedByName" TEXT,
    "validatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reception_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "receptionId" TEXT NOT NULL,
    "productId" TEXT,
    "variationId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "barcodeSnapshot" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reception_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "supplierId" TEXT NOT NULL,
    "receptionId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "CashPaymentMethod" NOT NULL DEFAULT 'ESPECES',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reference" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "saleNumber" SERIAL NOT NULL,
    "displayNumber" INTEGER,
    "salesChannelId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "customerId" TEXT,
    "customerLabel" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'MAD',
    "notes" TEXT,
    "soldById" TEXT,
    "soldByName" TEXT,
    "soldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "saleId" TEXT NOT NULL,
    "productId" TEXT,
    "variationId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "barcodeSnapshot" TEXT,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "costSnapshot" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "saleId" TEXT NOT NULL,
    "method" "CashPaymentMethod" NOT NULL DEFAULT 'ESPECES',
    "amount" DECIMAL(12,2) NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "returnNumber" SERIAL NOT NULL,
    "displayNumber" INTEGER,
    "saleId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "refundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundMethod" "CashPaymentMethod",
    "note" TEXT,
    "receivedById" TEXT,
    "receivedByName" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_lines" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "saleReturnId" TEXT NOT NULL,
    "saleLineId" TEXT,
    "nameSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "quantitySellable" INTEGER NOT NULL DEFAULT 0,
    "quantityDamaged" INTEGER NOT NULL DEFAULT 0,
    "warehouseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "suppliers_tenantId_name_idx" ON "suppliers"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "receptions_receptionNumber_key" ON "receptions"("receptionNumber");

-- CreateIndex
CREATE INDEX "receptions_supplierId_idx" ON "receptions"("supplierId");

-- CreateIndex
CREATE INDEX "receptions_warehouseId_idx" ON "receptions"("warehouseId");

-- CreateIndex
CREATE INDEX "receptions_status_idx" ON "receptions"("status");

-- CreateIndex
CREATE INDEX "receptions_receptionDate_idx" ON "receptions"("receptionDate");

-- CreateIndex
CREATE INDEX "receptions_tenantId_idx" ON "receptions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "receptions_tenantId_displayNumber_key" ON "receptions"("tenantId", "displayNumber");

-- CreateIndex
CREATE INDEX "reception_lines_receptionId_idx" ON "reception_lines"("receptionId");

-- CreateIndex
CREATE INDEX "reception_lines_productId_idx" ON "reception_lines"("productId");

-- CreateIndex
CREATE INDEX "reception_lines_variationId_idx" ON "reception_lines"("variationId");

-- CreateIndex
CREATE INDEX "reception_lines_tenantId_idx" ON "reception_lines"("tenantId");

-- CreateIndex
CREATE INDEX "supplier_payments_supplierId_idx" ON "supplier_payments"("supplierId");

-- CreateIndex
CREATE INDEX "supplier_payments_receptionId_idx" ON "supplier_payments"("receptionId");

-- CreateIndex
CREATE INDEX "supplier_payments_paidAt_idx" ON "supplier_payments"("paidAt");

-- CreateIndex
CREATE INDEX "supplier_payments_tenantId_idx" ON "supplier_payments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_saleNumber_key" ON "sales"("saleNumber");

-- CreateIndex
CREATE INDEX "sales_salesChannelId_soldAt_idx" ON "sales"("salesChannelId", "soldAt");

-- CreateIndex
CREATE INDEX "sales_warehouseId_idx" ON "sales"("warehouseId");

-- CreateIndex
CREATE INDEX "sales_soldAt_idx" ON "sales"("soldAt");

-- CreateIndex
CREATE INDEX "sales_soldById_idx" ON "sales"("soldById");

-- CreateIndex
CREATE INDEX "sales_customerId_idx" ON "sales"("customerId");

-- CreateIndex
CREATE INDEX "sales_tenantId_idx" ON "sales"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_idempotencyKey_key" ON "sales"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_displayNumber_key" ON "sales"("tenantId", "displayNumber");

-- CreateIndex
CREATE INDEX "sale_lines_saleId_idx" ON "sale_lines"("saleId");

-- CreateIndex
CREATE INDEX "sale_lines_productId_idx" ON "sale_lines"("productId");

-- CreateIndex
CREATE INDEX "sale_lines_variationId_idx" ON "sale_lines"("variationId");

-- CreateIndex
CREATE INDEX "sale_lines_tenantId_idx" ON "sale_lines"("tenantId");

-- CreateIndex
CREATE INDEX "sale_payments_saleId_idx" ON "sale_payments"("saleId");

-- CreateIndex
CREATE INDEX "sale_payments_tenantId_idx" ON "sale_payments"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_returnNumber_key" ON "sale_returns"("returnNumber");

-- CreateIndex
CREATE INDEX "sale_returns_saleId_idx" ON "sale_returns"("saleId");

-- CreateIndex
CREATE INDEX "sale_returns_tenantId_idx" ON "sale_returns"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_saleId_idempotencyKey_key" ON "sale_returns"("saleId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenantId_displayNumber_key" ON "sale_returns"("tenantId", "displayNumber");

-- CreateIndex
CREATE INDEX "sale_return_lines_saleReturnId_idx" ON "sale_return_lines"("saleReturnId");

-- CreateIndex
CREATE INDEX "sale_return_lines_saleLineId_idx" ON "sale_return_lines"("saleLineId");

-- CreateIndex
CREATE INDEX "sale_return_lines_warehouseId_idx" ON "sale_return_lines"("warehouseId");

-- CreateIndex
CREATE INDEX "sale_return_lines_tenantId_idx" ON "sale_return_lines"("tenantId");

-- CreateIndex
CREATE INDEX "inventory_movements_receptionLineId_idx" ON "inventory_movements"("receptionLineId");

-- CreateIndex
CREATE INDEX "inventory_movements_saleId_idx" ON "inventory_movements"("saleId");

-- CreateIndex
CREATE INDEX "inventory_movements_saleReturnId_idx" ON "inventory_movements"("saleReturnId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_receptionLineId_fkey" FOREIGN KEY ("receptionLineId") REFERENCES "reception_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_saleReturnId_fkey" FOREIGN KEY ("saleReturnId") REFERENCES "sale_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reception_lines" ADD CONSTRAINT "reception_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reception_lines" ADD CONSTRAINT "reception_lines_receptionId_fkey" FOREIGN KEY ("receptionId") REFERENCES "receptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reception_lines" ADD CONSTRAINT "reception_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reception_lines" ADD CONSTRAINT "reception_lines_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_receptionId_fkey" FOREIGN KEY ("receptionId") REFERENCES "receptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_salesChannelId_fkey" FOREIGN KEY ("salesChannelId") REFERENCES "sales_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_saleReturnId_fkey" FOREIGN KEY ("saleReturnId") REFERENCES "sale_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "sale_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- DB-enforced invariants Prisma's schema DSL cannot express (same technique as
-- stock_transfer_lines_quantities_check / order_return_lines_*_check).
-- ---------------------------------------------------------------------------
ALTER TABLE "reception_lines" ADD CONSTRAINT "reception_lines_quantity_positive_check" CHECK ("quantity" > 0);
ALTER TABLE "reception_lines" ADD CONSTRAINT "reception_lines_unit_cost_nonneg_check" CHECK ("unitCost" >= 0);
ALTER TABLE "receptions" ADD CONSTRAINT "receptions_total_nonneg_check" CHECK ("totalCost" >= 0);
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_amount_positive_check" CHECK ("amount" > 0);

ALTER TABLE "sales" ADD CONSTRAINT "sales_amounts_nonneg_check" CHECK ("subtotal" >= 0 AND "discountTotal" >= 0 AND "total" >= 0);
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_quantity_positive_check" CHECK ("quantity" > 0);
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_amounts_nonneg_check" CHECK ("unitPrice" >= 0 AND "discount" >= 0 AND "total" >= 0);
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_amount_positive_check" CHECK ("amount" > 0);
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_refund_nonneg_check" CHECK ("refundAmount" >= 0);
-- A return line always represents a real received quantity: both sides >= 0,
-- and not both zero (mirrors order_return_lines).
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_quantities_check"
    CHECK ("quantitySellable" >= 0 AND "quantityDamaged" >= 0 AND ("quantitySellable" + "quantityDamaged") > 0);

-- ---------------------------------------------------------------------------
-- RLS — identical policy shape to every other tenant-scoped table (ADR 0026).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','receptions','reception_lines','supplier_payments',
                           'sales','sale_lines','sale_payments','sale_returns','sale_return_lines']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY "tenant_isolation" ON %I
      USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))$p$, t);
  END LOOP;
END $$;
