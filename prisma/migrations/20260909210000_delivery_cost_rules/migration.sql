-- Delivery success / return / failure cost rules. See
-- docs/adr/0032-delivery-cost-rules.md.
--
--  * Shipment.costSource      — where Shipment.cost came from
--  * Shipment.costFinalizedAt — set once the cost is frozen (final state
--                               or manual override); after that neither a
--                               carrier re-fetch nor a provider-rule
--                               change may rewrite it
--  * ShippingProvider.returnCost / failureCost — the merchant's explicit
--    rule for a RETOURNE / ECHEC|ANNULE shipment (null = 0 for that
--    outcome). A successful delivery's price always comes from the
--    carrier API — these never touch it.
--
-- Backfill: an already-terminal shipment with a recorded cost is treated
-- as CARRIER_API and finalised at `updatedAt`, so historical figures stay
-- put. Non-terminal / cost-less rows are left untouched.

CREATE TYPE "ShipmentCostSource" AS ENUM ('CARRIER_API', 'RETURN_RULE', 'FAILURE_RULE', 'MANUAL_OVERRIDE');

ALTER TABLE "shipments" ADD COLUMN "costSource" "ShipmentCostSource";
ALTER TABLE "shipments" ADD COLUMN "costFinalizedAt" TIMESTAMP(3);

ALTER TABLE "shipping_providers" ADD COLUMN "returnCost" DECIMAL(12,2);
ALTER TABLE "shipping_providers" ADD COLUMN "failureCost" DECIMAL(12,2);

UPDATE "shipments"
SET "costSource" = 'CARRIER_API', "costFinalizedAt" = "updatedAt"
WHERE "cost" IS NOT NULL
  AND "status" IN ('LIVRE', 'ECHEC', 'RETOURNE', 'ANNULE');
