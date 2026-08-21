# ADR 0006 — Delivery provider architecture

## Status
Accepted (2026-08-21)

## Context
The brief is explicit: support multiple delivery providers via an adapter
interface, don't hardcode one Moroccan delivery company.

## Decision
`ShippingProvider` (`type`: `MANUEL` / `FLOTTE_INTERNE` / `API`,
`isActive`, non-secret `config` JSON) is the provider registry — any number
of providers can be created from the Livraison page, each independently
active/inactive. `Shipment` links one `Order` to one `ShippingProvider`
with its own status lifecycle (`ShipmentStatus`, transition table in
`src/lib/validation/delivery.ts:SHIPMENT_STATUS_TRANSITIONS`, terminal
states `LIVRE`/`ANNULE`), tracking number, tracking URL, and cost.

For this phase, every provider is operationally `MANUEL` — tracking
numbers and status changes are entered by staff, not fetched from a
carrier API. The `type` field and `config` JSON exist so a future `API`
provider (e.g. a specific Moroccan carrier's REST API) can be added without
a schema change: its adapter would live in a new
`src/lib/delivery/<provider>.ts` implementing a common interface (not yet
defined, since there's no second real implementation to generalize from
— defining an interface from a single implementation tends to guess wrong
about what the abstraction actually needs).

`getDeliveryStats()` computes "taux de livraison réussie" as
`delivered / total shipments` — `null` (rendered "Aucune expédition", never
0%) when no shipments exist yet, per the Data Integrity Principle.

## Audit addendum (2026-08-21 A–G pre-integration hardening)
Two gaps found during the pre-integration audit:

1. **Shipment creation had no order-status gate.** `createShipmentAction`
   previously accepted a shipment for any order regardless of status — a
   brand-new (`NOUVELLE`) or already-cancelled (`ANNULEE`) order could get a
   `Shipment` row. Fixed by restricting creation to
   `SHIPPABLE_ORDER_STATUSES = ["CONFIRMEE", "EN_PREPARATION", "ECHEC"]` (the
   `ECHEC` case covers re-shipping after a failed delivery attempt). A
   non-existent `providerId` is also now rejected explicitly instead of
   failing on the FK constraint.
2. **Order/Shipment state machines could silently diverge.** A shipment
   reaching `LIVRE` had no effect on the linked `Order.status`, which could
   stay `EXPEDIEE` forever even after real-world delivery. Fixed with a
   one-directional auto-sync: when a shipment transitions to `LIVRE` and the
   order's own transition table (`canTransitionOrderStatus`) allows
   `EXPEDIEE → LIVREE`, the order is atomically advanced to `LIVREE` with
   `deliveredAt` set, inside the same transaction as the shipment update. If
   the order isn't in `EXPEDIEE` for some reason, this is skipped silently
   rather than erroring — the shipment update is correct on its own either
   way. Deliberately **not** extended to auto-sync `ECHEC`/`RETOURNE`
   shipment statuses back onto the order, since those cases need staff
   judgment (e.g. retry vs. cancel vs. refund) rather than one obvious
   mapping — see `tests/actions/delivery.test.ts`.

Both fixes use the same conditional-`updateMany` + row-count-check
concurrency pattern documented in `docs/adr/0002-domain-model.md`'s audit
addendum.

## Deferred (explicitly, not silently)
- **Any real carrier API integration** (rate calculation, label
  generation, automatic tracking updates, webhook-driven status sync).
- **Delivery zone / rate configuration** beyond the free-form `config`
  JSON field.
