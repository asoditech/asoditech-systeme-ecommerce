-- Transfer purchase-cost override — Phase 1 (backend foundation).
-- Additive only: one settings flag defaulting to false (existing tenants keep
-- quantity-only transfers) and one nullable line column (every existing
-- transfer line keeps NULL = no override). No data is rewritten.

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN     "transferPurchaseCostOverrideEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stock_transfer_lines" ADD COLUMN     "destinationUnitCost" DECIMAL(12,2);

-- A purchase cost is never negative (same rule as reception_lines.unitCost).
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_destination_unit_cost_nonneg_check" CHECK ("destinationUnitCost" IS NULL OR "destinationUnitCost" >= 0);
