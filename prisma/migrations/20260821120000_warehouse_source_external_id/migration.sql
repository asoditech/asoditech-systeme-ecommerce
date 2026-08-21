-- Phase 21 (Shopify integration): each Shopify Location maps to its own
-- Warehouse row rather than collapsing multi-location inventory into a
-- single number — see docs/adr/0011-shopify-integration.md.
ALTER TABLE "warehouses" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'INTERNE';

CREATE INDEX "warehouses_source_externalId_idx" ON "warehouses"("source", "externalId");
