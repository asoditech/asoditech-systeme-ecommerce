-- Added during Phase 20 (WooCommerce integration): prevents a duplicate
-- Order under a genuine race between the order webhook and a concurrent
-- manual sync both importing the same WooCommerce order for the first
-- time. Postgres unique indexes allow multiple NULLs, so this never
-- restricts INTERNE orders (source='INTERNE', externalId always NULL) —
-- see docs/adr/0010-woocommerce-integration.md.
DROP INDEX IF EXISTS "orders_source_externalId_idx";

CREATE UNIQUE INDEX "orders_source_externalId_key" ON "orders"("source", "externalId");
