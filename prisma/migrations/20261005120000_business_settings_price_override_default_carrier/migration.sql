-- Business settings: seller price override toggle + default delivery company.
-- Additive only: two new columns on "business_settings", no data rewritten.
--  - "allowSellerPriceOverride" defaults to false, so every existing tenant
--    keeps today's behaviour (only users holding `sales.override_price` may
--    change a store price). PostgreSQL adds a constant default without
--    rewriting the table.
--  - "defaultShippingProviderId" is nullable (no default company until a
--    manager picks one) and is cleared automatically if that company is
--    deleted (ON DELETE SET NULL).
-- No new table, so no RLS policy or grant is needed: "business_settings"
-- already has both.

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN     "allowSellerPriceOverride" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "defaultShippingProviderId" TEXT;

-- AddForeignKey
ALTER TABLE "business_settings" ADD CONSTRAINT "business_settings_defaultShippingProviderId_fkey" FOREIGN KEY ("defaultShippingProviderId") REFERENCES "shipping_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
