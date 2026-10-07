-- Location purchase cost — Phase 2.
-- Additive only: one nullable column. Every existing inventory row keeps NULL,
-- i.e. its effective cost stays the global variation/product cost, unchanged.
-- No data is rewritten.

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN     "currentUnitCost" DECIMAL(12,2);

-- A purchase cost is never negative (same rule as reception and transfer costs).
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_current_unit_cost_nonneg_check" CHECK ("currentUnitCost" IS NULL OR "currentUnitCost" >= 0);
