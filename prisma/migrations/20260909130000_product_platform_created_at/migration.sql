-- products.platformCreatedAt — the moment a product came into existence
-- for the merchant (platform `date_created` for imported products, `now()`
-- for products created in-app). The catalogue list sorts on this so the
-- most recently created product shows first, regardless of when a sync
-- first happened to import it (`createdAt` is only the local insert time).
--
-- Backfill: every existing row gets `createdAt` as a sane starting value.
-- The next WooCommerce / Shopify product sync overwrites imported rows
-- with the real platform date.

ALTER TABLE "products" ADD COLUMN "platformCreatedAt" TIMESTAMP(3);

UPDATE "products" SET "platformCreatedAt" = "createdAt" WHERE "platformCreatedAt" IS NULL;

CREATE INDEX "products_tenantId_platformCreatedAt_idx" ON "products" ("tenantId", "platformCreatedAt");
