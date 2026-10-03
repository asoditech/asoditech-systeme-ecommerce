# ADR 0055 — Store → ASODITECH product identity reconciliation

## Status
Accepted (2026-10-02). Fixes the duplicate-product limitation recorded in ADR
0054. No schema change, no migration.

## Problem
Every integration path identifies a store product by `(source, externalId)`:
- product sync and the product webhooks;
- order-line mapping;
- stock push;
- the deletion webhooks.

A product created in ASODITECH and then placed in the store by CSV import or
« Publier » keeps `source = INTERNE` and no `externalId`. The next sync or
« product created » webhook therefore imported it again as a new product with a
suffixed SKU (`-wc-<id>`, `-shop-<id>`). Order lines for that store product
were not linked to the ASODITECH product, and its stock was not pushed.
`ProductPublication` was written by « Publier » but read by nothing.

## Decision
One resolver, `src/lib/integrations/shared/identity.ts`, used by the
WooCommerce and Shopify product syncs. The product webhooks go through the same
functions. The first hit wins:
1. **Linked:** `(source = provider, externalId)`. This is the existing
   behaviour.
2. **Publication:** a `ProductPublication(provider, externalId)` whose product
   is still unlinked.
3. **SKU:** exactly one unlinked (`INTERNE`) product of the tenant with that
   SKU, of the same shape (variable ⇔ has variations), and not published to
   that provider under another id.
   - A Shopify variable product has no parent SKU: every matching variant SKU
     must belong to the same unlinked product.
4. **Otherwise** a new product is created, unchanged.

A match is **adopted**: the existing product takes the store identity
(`source`, `externalId`) through a conditional update (only while still
unlinked), and a `ProductPublication` records the link. Every other path then
recognizes it with no change:
- order lines map to it;
- stock push includes it;
- replays are idempotent.

Variations follow the same rule strictly **within their parent**. A variation
of another product is never adopted. A Shopify sync no longer flattens an
adopted variation's structured attributes to `{ Variante: title }` when they
already spell that title.

Never by name; never two existing products merged; never across tenants (the
tenant-scoped client and RLS). Stock is untouched: the store only initializes a
stock row ASODITECH does not have (ADR 0036).

## Consequences
- An adopted product becomes store-linked, like any synced product. Its
  name, SKU, description, price and status are then store-owned and refreshed
  by each sync (field ownership, ADR 0010).
- On adoption, the ASODITECH category is kept while the store's category is
  not known locally.

## Limitations
- **Order before link:** an order imported BEFORE its product was synced or
  adopted keeps an unlinked line, as for any new store product.
- **One store identity per product:** a product adopted by one store keeps its
  publication to the other provider, but only one store identity can be held in
  `source`/`externalId`.
- **Duplicate categories:** the store's category sync may still create a
  same-name category next to an ASODITECH one; categories are not reconciled
  here.
