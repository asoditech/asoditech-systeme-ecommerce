-- Automatic customer codes « CL-000001 » (docs/adr/0060).
--
-- Additive only:
--  - customers.barcode: nullable, unique per tenant. Postgres treats NULLs as
--    distinct in a unique index, so every existing customer stays without a
--    code — NO backfill here.
--  - tenants.customerBarcodesGranted: platform-controlled grant, default off.
--  - tenants.nextCustomerBarcodeNumber: per-tenant counter, starts at 1.
--  - business_settings.customerBarcodeEnabled: the tenant's own switch,
--    default off (effective only while granted).
-- "customers", "tenants" and "business_settings" are existing tables already
-- covered by their RLS policies and the runtime role's privileges — no new
-- table, no new grant.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN "barcode" TEXT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "customerBarcodesGranted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "nextCustomerBarcodeNumber" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN "customerBarcodeEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenantId_barcode_key" ON "customers"("tenantId", "barcode");
