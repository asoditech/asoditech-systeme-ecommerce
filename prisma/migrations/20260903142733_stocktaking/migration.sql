-- Phase 32c — stocktaking. See docs/adr/0021-stocktaking.md.
--
-- Fully additive: no column on an existing table becomes NOT NULL (unlike
-- 32b), so there is NO backfill. Hand-edited after
-- `prisma migrate dev --create-only` for two raw-SQL bits Prisma's DSL
-- can't express on the 6.19 line (same precedent as
-- prisma/migrations/20260821020000_inventory_item_exactly_one_ref_check):
--   1. a CHECK that a counted quantity is never negative;
--   2. a PARTIAL unique index enforcing at most one EN_COURS session per
--      warehouse.

-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('EN_COURS', 'CLOTURE', 'ANNULE');

-- AlterEnum
-- 'INVENTAIRE' is only ADDED here, never used in this migration (no row is
-- inserted with it, no column defaults to it), so it is safe in the single
-- wrapping transaction on PostgreSQL 12+.
ALTER TYPE "InventoryMovementType" ADD VALUE 'INVENTAIRE';

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "stocktakeSessionId" TEXT;

-- CreateTable
CREATE TABLE "stocktake_sessions" (
    "id" TEXT NOT NULL,
    "sessionNumber" SERIAL NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'EN_COURS',
    "notes" TEXT,
    "startedById" TEXT,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stocktake_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_lines" (
    "id" TEXT NOT NULL,
    "stocktakeSessionId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "systemQuantityAtCount" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "countedAt" TIMESTAMP(3),
    "countedById" TEXT,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "appliedMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- CheckConstraint: a counted quantity, when set, is never negative.
ALTER TABLE "stocktake_lines"
  ADD CONSTRAINT "stocktake_lines_counted_quantity_check"
  CHECK ("countedQuantity" IS NULL OR "countedQuantity" >= 0);

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_sessions_sessionNumber_key" ON "stocktake_sessions"("sessionNumber");

-- CreateIndex
CREATE INDEX "stocktake_sessions_status_idx" ON "stocktake_sessions"("status");

-- CreateIndex
CREATE INDEX "stocktake_sessions_warehouseId_idx" ON "stocktake_sessions"("warehouseId");

-- CreateIndex
CREATE INDEX "stocktake_sessions_createdAt_idx" ON "stocktake_sessions"("createdAt");

-- Partial unique index: at most one open (EN_COURS) session per warehouse.
CREATE UNIQUE INDEX "stocktake_sessions_one_open_per_warehouse"
  ON "stocktake_sessions" ("warehouseId")
  WHERE "status" = 'EN_COURS';

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_lines_appliedMovementId_key" ON "stocktake_lines"("appliedMovementId");

-- CreateIndex
CREATE INDEX "stocktake_lines_stocktakeSessionId_idx" ON "stocktake_lines"("stocktakeSessionId");

-- CreateIndex
CREATE INDEX "stocktake_lines_inventoryItemId_idx" ON "stocktake_lines"("inventoryItemId");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_lines_stocktakeSessionId_inventoryItemId_key" ON "stocktake_lines"("stocktakeSessionId", "inventoryItemId");

-- CreateIndex
CREATE INDEX "inventory_movements_stocktakeSessionId_idx" ON "inventory_movements"("stocktakeSessionId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stocktakeSessionId_fkey" FOREIGN KEY ("stocktakeSessionId") REFERENCES "stocktake_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_sessions" ADD CONSTRAINT "stocktake_sessions_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_sessions" ADD CONSTRAINT "stocktake_sessions_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_sessions" ADD CONSTRAINT "stocktake_sessions_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_stocktakeSessionId_fkey" FOREIGN KEY ("stocktakeSessionId") REFERENCES "stocktake_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_countedById_fkey" FOREIGN KEY ("countedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_appliedMovementId_fkey" FOREIGN KEY ("appliedMovementId") REFERENCES "inventory_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
