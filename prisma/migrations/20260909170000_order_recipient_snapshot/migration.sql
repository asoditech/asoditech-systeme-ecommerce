-- orders.shippingName — recipient-name snapshot at time of order, so the
-- name shown for an order is the order's own billing/shipping name, not
-- the (possibly shared) linked customer's canonical name. See
-- docs/adr/0030-order-stock-reservation-and-recipient.md.
--
-- Backfill: every existing order takes its current customer's name as a
-- sane starting value. The next WooCommerce/Shopify re-import overwrites
-- imported orders with the order's real billing name.

ALTER TABLE "orders" ADD COLUMN "shippingName" TEXT;

UPDATE "orders" o
SET "shippingName" = c."fullName"
FROM "customers" c
WHERE o."customerId" = c."id" AND o."shippingName" IS NULL;
