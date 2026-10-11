# Carrier exchange capabilities — research (S9, 2026-10-10)

Research only — nothing is implemented. Facts are marked **Confirmed**
(repository code / ADR / carrier sample code), **Not found** (searched, no
evidence) or **Unknown** (needs the carrier). Ordinary shipment-creation
fields are never read as an exchange capability.

## Sources checked

- Adapters: `src/lib/integrations/delivery/providers/ozonexpress/*`,
  `.../aramex/*`; ADRs 0013 (OzonExpress), 0028 (Aramex), 0012, 0032.
- Aramex's own Shipping Services API sample code (local, gitignored:
  `aramex/shipping-services-api-sample-code/`).
- Public web: no public OzonExpress API documentation exists (ADR 0013,
  confirmed again by a web search). The official Aramex « Shipping Services
  API manual » PDF (aramex.com) answers HTTP 403 to automated fetches — not
  read.

## OzonExpress

| Capability | Status | Evidence |
|---|---|---|
| Exchange / replacement shipment | **Not found** | `add-parcel` takes receiver, phone, city, address, price, `parcel-stock` (pickup / stock), nature, note — no exchange or linked-parcel field (`mapper.ts`). |
| Return pickup / reverse logistics | **Not found** | Only outcome fees `RETURNED-PRICE` / `REFUSED-PRICE` (a returned parcel is billed), no endpoint to order a pickup at the customer. |
| Carrier-side cancellation | **Not found** | ADR 0013: « No cancellation endpoint is known to exist »; `CANCEL_SHIPMENT` not declared. |
| COD of a price difference | **Partly confirmed** | The COD amount is the `price` field of any parcel, so a replacement parcel can carry any amount (incl. 0 or a difference). Collecting from the customer on a RETURN leg: **Unknown**. |
| Tracking / settlement of both legs | **Unknown** | Tracking per tracking number works; how an exchange's two legs appear in OzonExpress settlement statements is unknown. |

## Aramex

| Capability | Status | Evidence |
|---|---|---|
| Exchange / replacement shipment | **Not found** | Sample code: `ProductGroup` `EXP`/`DOM`, `ProductType` e.g. `PDX`, `Services` (empty in samples) — no exchange product seen. |
| Return pickup / reverse logistics | **Unknown** | `CreatePickup` / `CancelPickup` exist (pickup scheduling); whether a pickup can collect at the CUSTOMER with a return AWB, and which product type, is not in the samples. Third-party sources mention return labels only for other markets. |
| Carrier-side cancellation | **Confirmed absent per AWB** | ADR 0028: cancel is pickup-scoped (`CancelPickup`), no « cancel this waybill ». |
| COD of a price difference | **Confirmed field** | `CashOnDeliveryAmount { Value, CurrencyCode }` on a shipment — a replacement shipment can carry a difference. Applicability on a return leg: **Unknown**. |
| Linking the two legs | **Partly confirmed** | `ForeignHAWB` and shipment references are free merchant references — usable to tag both legs with the exchange id; Aramex-side meaning beyond that: **Unknown**. |
| Tracking / settlement of both legs | **Unknown** | `TrackShipments` works per AWB; settlement of a return leg unknown. |

## Questions for each account manager

Send to OzonExpress and to Aramex Morocco:

1. Do you offer an « échange » service (deliver the new item and collect the
   old one in the same visit)? Through the API — which endpoint / product /
   field — or only through your portal?
2. Can we order a pickup AT THE CUSTOMER for a return (reverse parcel) by
   API? What does it return (tracking number) and what does it cost?
3. On an exchange or a reverse pickup, can the courier collect cash (a price
   difference) from the customer? Which field?
4. How do the two legs appear in tracking (one tracking number or two;
   which statuses) and in your COD settlement / invoices?
5. Can a created parcel be cancelled by API (OzonExpress: none known; Aramex:
   only `CancelPickup` — does that void the AWB)?
6. Aramex: which `ProductGroup` / `ProductType` / `Services` codes apply to a
   domestic Moroccan return or exchange, and is it enabled on our account?

## Proposed later model (opt-in, not built)

Smallest model that never duplicates an order, never books revenue twice,
never moves stock twice, and keeps the original history:

- `BusinessSettings.exchangesEnabled` (default false) — a tenant opts in.
- `OrderExchange` attached to the ORIGINAL order: `reason`
  (`CUSTOMER_CHOICE` « mauvaise taille choisie » | `STORE_ERROR` « erreur de
  préparation »), `status` (OPEN → REPLACEMENT_SENT → RETURN_RECEIVED →
  CLOSED | CANCELLED), lines (original order item → replacement product /
  variation, quantity), `priceDifference`, `shippingPaidBy`
  (CUSTOMER | STORE).
- Replacement leg: an ordinary `Shipment` with a nullable `exchangeId`;
  its stock leaves through ONE dedicated movement tied to the exchange
  (never the order's « Expédiée » deduction again); its COD = the price
  difference (0 for a store error).
- Return leg: the existing reception → inspection workflow on the original
  order (sellable / damaged), whose per-order cap already prevents double
  restocking.
- Revenue: the original order is unchanged; only `priceDifference` is
  booked (and refunded if negative) — no second order.
- Analytics: exchange shipments are excluded from delivery-rate / order
  counts (they are not new sales) but their costs count.
- Audit: every step on the original order's history.
- By reason: CUSTOMER_CHOICE — shipping per tenant policy, difference
  collected or refunded; STORE_ERROR — the store pays both legs, difference
  usually 0, flagged for picking-error follow-up.
- Carrier: manual fallback first (replacement parcel with a note « Échange —
  récupérer l'article X », linked by `ForeignHAWB` / note); automate only
  after the answers above.

Requires a migration (the `OrderExchange` table, `Shipment.exchangeId`,
`BusinessSettings.exchangesEnabled`) and a new movement type.
