-- Backfill: this deployment ships only within Morocco. An order whose
-- shipping country was never captured (or came in as a bare "MA" code) is
-- normalised to "Maroc" — the value the app now displays and uses for
-- shipment creation. See src/lib/format.ts DEFAULT_SHIPPING_COUNTRY.

UPDATE "orders"
SET "shippingCountry" = 'Maroc'
WHERE "shippingCountry" IS NULL
   OR btrim("shippingCountry") = ''
   OR lower(btrim("shippingCountry")) IN ('ma', 'mar', 'morocco', 'maroc');
