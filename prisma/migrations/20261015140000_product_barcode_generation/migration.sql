-- Automatic product / variation barcode generation (docs/adr/0061).
--
-- Additive only, two columns with defaults; no existing row changes meaning:
--  - tenants.nextProductBarcodeNumber: per-tenant counter (BIGINT — the
--    generated EAN-13 carries a 10-digit sequence), starts at 1.
--  - business_settings.productBarcodeAutoEnabled: the tenant switch, default
--    off = manual barcode entry only, exactly as before.
-- Barcode uniqueness is unchanged: the existing unique index
-- "barcodes_tenantId_code_key" (one code per tenant, products and variations
-- share it) already enforces it. No new table, no RLS change, no new grant
-- ("tenants" and "business_settings" are existing tables). No backfill: no
-- existing product or variation receives a code.

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "nextProductBarcodeNumber" BIGINT NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN "productBarcodeAutoEnabled" BOOLEAN NOT NULL DEFAULT false;
