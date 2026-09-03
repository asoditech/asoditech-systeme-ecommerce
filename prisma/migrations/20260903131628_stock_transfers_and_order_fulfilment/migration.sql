-- Phase 32b — stock transfers + order fulfilment warehouse.
-- See docs/adr/0020-stock-transfers.md.
--
-- Hand-edited after `prisma migrate dev --create-only` for two reasons the
-- generator can't handle safely:
--   1. `inventory_movements.warehouseId` becomes NOT NULL, but the table
--      has existing rows — it is added nullable, backfilled deterministically
--      from `inventory_items.warehouseId` (every movement has always been
--      applied to an InventoryItem: `inventoryItemId` is NOT NULL with
--      onDelete: Cascade, so no orphan movement can exist and the backfill
--      is total), verified to leave zero NULLs, then set NOT NULL.
--   2. two raw-SQL CHECK constraints Prisma's DSL can't express on the
--      6.19 line (source <> destination; transfer line quantity bounds) —
--      same precedent as prisma/migrations/20260821020000_inventory_item_exactly_one_ref_check.

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('BROUILLON', 'EN_TRANSIT', 'RECU', 'ANNULE');

-- AlterEnum
-- New movement types are only ADDED here, never used in this migration, so
-- this is safe in the single wrapping transaction on PostgreSQL 12+.
ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFERT_SORTIE';
ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFERT_ENTREE';

-- AlterTable: inventory_movements — add nullable, backfill, verify, SET NOT NULL
ALTER TABLE "inventory_movements" ADD COLUMN "stockTransferId" TEXT;
ALTER TABLE "inventory_movements" ADD COLUMN "warehouseId" TEXT;

UPDATE "inventory_movements" m
SET "warehouseId" = i."warehouseId"
FROM "inventory_items" i
WHERE i."id" = m."inventoryItemId";

DO $$
DECLARE
  remaining BIGINT;
BEGIN
  SELECT COUNT(*) INTO remaining FROM "inventory_movements" WHERE "warehouseId" IS NULL;
  IF remaining > 0 THEN
    RAISE EXCEPTION 'inventory_movements.warehouseId backfill incomplete: % row(s) still NULL', remaining;
  END IF;
END $$;

ALTER TABLE "inventory_movements" ALTER COLUMN "warehouseId" SET NOT NULL;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "fulfillmentWarehouseId" TEXT;

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" TEXT NOT NULL,
    "transferNumber" SERIAL NOT NULL,
    "sourceWarehouseId" TEXT NOT NULL,
    "destinationWarehouseId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'BROUILLON',
    "notes" TEXT,
    "createdById" TEXT,
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" TEXT NOT NULL,
    "stockTransferId" TEXT NOT NULL,
    "productId" TEXT,
    "variationId" TEXT,
    "quantitySent" INTEGER NOT NULL,
    "quantityReceived" INTEGER,

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CheckConstraint: a transfer's source and destination must differ.
ALTER TABLE "stock_transfers"
  ADD CONSTRAINT "stock_transfers_source_ne_destination_check"
  CHECK ("sourceWarehouseId" <> "destinationWarehouseId");

-- CheckConstraint: quantitySent > 0; quantityReceived, when set, is within [0, quantitySent].
ALTER TABLE "stock_transfer_lines"
  ADD CONSTRAINT "stock_transfer_lines_quantities_check"
  CHECK (
    "quantitySent" > 0
    AND (
      "quantityReceived" IS NULL
      OR ("quantityReceived" >= 0 AND "quantityReceived" <= "quantitySent")
    )
  );

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_transferNumber_key" ON "stock_transfers"("transferNumber");

-- CreateIndex
CREATE INDEX "stock_transfers_status_idx" ON "stock_transfers"("status");

-- CreateIndex
CREATE INDEX "stock_transfers_sourceWarehouseId_idx" ON "stock_transfers"("sourceWarehouseId");

-- CreateIndex
CREATE INDEX "stock_transfers_destinationWarehouseId_idx" ON "stock_transfers"("destinationWarehouseId");

-- CreateIndex
CREATE INDEX "stock_transfers_createdAt_idx" ON "stock_transfers"("createdAt");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_stockTransferId_idx" ON "stock_transfer_lines"("stockTransferId");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_productId_idx" ON "stock_transfer_lines"("productId");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_variationId_idx" ON "stock_transfer_lines"("variationId");

-- CreateIndex
CREATE INDEX "inventory_movements_warehouseId_createdAt_idx" ON "inventory_movements"("warehouseId", "createdAt");

-- CreateIndex
CREATE INDEX "inventory_movements_stockTransferId_idx" ON "inventory_movements"("stockTransferId");

-- CreateIndex
CREATE INDEX "orders_fulfillmentWarehouseId_idx" ON "orders"("fulfillmentWarehouseId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stockTransferId_fkey" FOREIGN KEY ("stockTransferId") REFERENCES "stock_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_sourceWarehouseId_fkey" FOREIGN KEY ("sourceWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destinationWarehouseId_fkey" FOREIGN KEY ("destinationWarehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dispatchedById_fkey" FOREIGN KEY ("dispatchedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_stockTransferId_fkey" FOREIGN KEY ("stockTransferId") REFERENCES "stock_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_variationId_fkey" FOREIGN KEY ("variationId") REFERENCES "product_variations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfillmentWarehouseId_fkey" FOREIGN KEY ("fulfillmentWarehouseId") REFERENCES "warehouses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
