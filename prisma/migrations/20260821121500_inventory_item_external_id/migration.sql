-- Phase 21 (Shopify integration): Shopify's InventoryItem is a distinct
-- resource from Product/ProductVariant, and its gid is exactly what the
-- inventorySetQuantities mutation requires when pushing stock back —
-- see docs/adr/0011-shopify-integration.md.
ALTER TABLE "inventory_items" ADD COLUMN "externalId" TEXT;
