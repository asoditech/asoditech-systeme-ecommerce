-- Order.placedAt — the real customer-facing order date (WooCommerce /
-- Shopify `date_created`, or now() for a manual order). `createdAt` on an
-- imported order is only the sync timestamp, which made every "orders this
-- month" figure wrong for a freshly connected store.
--
-- Added NOT NULL with a default (a metadata-only change on PostgreSQL 11+,
-- no table rewrite), then backfilled from `createdAt` — the best value
-- available for existing rows. A subsequent orders re-sync corrects the
-- imported ones precisely (see syncOrders).
ALTER TABLE "orders" ADD COLUMN "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "orders" SET "placedAt" = "createdAt";

CREATE INDEX "orders_placedAt_idx" ON "orders"("placedAt");
