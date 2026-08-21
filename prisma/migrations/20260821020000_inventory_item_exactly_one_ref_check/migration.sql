-- Added during the A-G audit: nothing previously stopped application code
-- (a future bug, a hand-run script, a bad migration) from creating an
-- InventoryItem with both productId and variationId set, or neither. Both
-- cases would corrupt stock lookups silently (applyMovement's findFirst by
-- productId/variationId would match the wrong row, or match none). Enforce
-- "exactly one of the two" at the database level, not just in the two
-- application code paths that currently create these rows
-- (createProductAction, createProductVariationAction) --
-- see docs/adr/0005-inventory-and-sync.md.
ALTER TABLE "inventory_items"
  ADD CONSTRAINT "inventory_items_exactly_one_ref_check"
  CHECK (
    ((("productId" IS NOT NULL))::int + (("variationId" IS NOT NULL))::int) = 1
  );
