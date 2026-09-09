# ADR 0032 — Delivery success / return / failure cost rules

## Status
Accepted (2026-09-09). Builds on ADR 0012 (provider adapter), ADR 0013
(OzonExpress), ADR 0028 (Aramex), ADR 0007 (finance).

## The non-negotiable rule

> **For a successful delivery, the carrier's API is the source of truth
> for the price. ASODITECH never invents, estimates, guesses, or falls
> back to its own delivery price when the provider has an API.**

This was already true in the adapters (OzonExpress reads `DELIVERED-PRICE`
from its own `GET /cities` catalogue and `add-parcel` response; Aramex
calls `CalculateRate`) — nothing here changes that. What this ADR adds is
the **model around it**: cost source tracking, freezing, merchant rules
for the outcomes that are *not* a successful delivery, and audit.

## Model

### Three financial outcomes, three sources

| Shipment reaches | Cost | Source |
| --- | --- | --- |
| `LIVRE` (API provider) | the carrier's own price — or `null` ("unknown") if the carrier gave none | `CARRIER_API` |
| `LIVRE` (manual provider) | the figure the operator entered on the shipment | *(unchanged)* |
| `RETOURNE` | `provider.returnCost` (null ⇒ 0) | `RETURN_RULE` |
| `ECHEC` / `ANNULE` | `provider.failureCost` (null ⇒ 0) | `FAILURE_RULE` |
| accounting correction | operator-entered, `finance.manage` only, audited | `MANUAL_OVERRIDE` |

`resolveFinalShipmentCost(status, carrierCost, rules)` in `src/lib/delivery.ts`
is the single decision point. The return rule is **not** "same as the
delivery cost" and **not** "a percentage of it" — an explicit amount.

### Freezing

`Shipment.costFinalizedAt` is set the moment a shipment reaches a final
state (`FINAL_SHIPMENT_STATUSES = LIVRE | ECHEC | RETOURNE | ANNULE`) or a
manual override. After that:

- `syncShipmentStatus` no longer writes `cost` from a carrier re-fetch.
- Changing `provider.returnCost` / `failureCost` never rewrites it —
  finance always reads the stored per-shipment value.

In flight, `Shipment.cost` holds the carrier's own pre-delivery estimate
(`costSource: CARRIER_API`, `costFinalizedAt: null`) — shown as
"(estimation)" in the UI.

### API failure (§8)

A missing carrier price is `cost: null` / `costSource: null` — "unknown",
resolved on delivery. The parcel is still created (it exists at the
carrier — we can't un-create it); it is never assigned a fabricated
price, a previous city's price, or an ASODITECH default. A manual
override is the only way to set it, and it is explicit + audited, never
automatic.

## Provider settings

`ShippingProvider.returnCost` / `failureCost` (Decimal?, null = 0).
Edited via the « Tarification » dialog on Livraison → Prestataires, which
states plainly that **the successful-delivery price is the carrier's**
and can't be entered there for an API provider.
`updateShippingProviderPricingAction` (`delivery.manage`) audits every
change with old → new (`shipping_provider.pricing_updated`).

## Finance & reporting (§9)

`computePeriodProfitability` and `getDeliveryPerformanceReport` group the
recorded shipment cost by `costSource` and expose
`carrierDeliveryCost` / `returnCostTotal` / `failureCostTotal`
(+ `costOverrideTotal`); the total still feeds net profit. They read the
**recorded** cost, never today's provider settings. Both also exclude
failed API-creation attempts (ADR 0031).

## Audit (§10)

- `shipping_provider.pricing_updated` — user, provider, `{returnCost,
  failureCost}` before → after.
- `shipment.cost_overridden` — user, shipment, cost + source before →
  after, mandatory `reason` in metadata.
- `shipment.status_changed` now also carries the `{cost, costSource}` that
  was frozen by the transition.

## Files
- `prisma/schema.prisma` — `ShipmentCostSource` enum, `Shipment.costSource`
  + `costFinalizedAt`, `ShippingProvider.returnCost` + `failureCost`.
  Migration `20260909210000_delivery_cost_rules` (backfills already-final
  shipments as `CARRIER_API`, finalised at `updatedAt`).
- `src/lib/delivery.ts` — `resolveFinalShipmentCost`,
  `FINAL_SHIPMENT_STATUSES`, cost finalisation inside
  `applyShipmentStatusTransition`.
- `src/lib/integrations/delivery/service.ts` — `createShipmentViaProvider`
  stamps `costSource`; `syncShipmentStatus` won't re-cost a frozen shipment
  and passes the fresh carrier price through for a LIVRE finalisation.
- `src/actions/delivery.ts` — `updateShippingProviderPricingAction`,
  `overrideShipmentCostAction`.
- `src/components/delivery/provider-pricing-dialog.tsx`,
  `override-shipment-cost-dialog.tsx`.
- Tests: `tests/lib/delivery-cost-rules.test.ts`,
  `tests/lib/delivery-service.test.ts`, `tests/actions/delivery.test.ts`,
  `tests/lib/delivery-queries.test.ts`.

## Consequences
- The adapters are unchanged — the carrier stays the source of truth.
- A historical shipment's cost is stable regardless of later settings
  changes.
- Return / failure costs are visible as separate lines in finance and the
  delivery report, not buried in one "delivery cost" number.
