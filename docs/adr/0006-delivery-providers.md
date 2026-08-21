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

## Deferred (explicitly, not silently)
- **Any real carrier API integration** (rate calculation, label
  generation, automatic tracking updates, webhook-driven status sync).
- **Delivery zone / rate configuration** beyond the free-form `config`
  JSON field.
