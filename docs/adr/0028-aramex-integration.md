# ADR 0028 — Aramex delivery adapter

## Status
Accepted (2026-09-09). **Not yet live-verified** — the adapter is
registered in production for configuration + connection testing only, on
the same posture ADR 0013 defined for OzonExpress before its live call.

## Context
`docs/adr/0012-delivery-provider-integration.md` built the
provider-agnostic delivery architecture (`DeliveryProviderAdapter`,
registry, capability model, credential lifecycle, shipment state machine).
`docs/adr/0013` added the first real carrier, OzonExpress. The owner now
also uses **Aramex** and supplied a vendor bundle (`aramex/` — WSDL +
PHP/C#/VB sample code, gitignored, not app code) to integrate it.

Aramex must be a second adapter behind the existing abstraction, with
nothing Aramex-specific leaking into the generic delivery service, DB
orchestration, shipment UI, finance layer, or order engine.

## API research

Aramex publishes an official Shipping API. The WSDLs in the owner bundle
are SOAP and date from 2012, but Aramex exposes the **same operations as
JSON over HTTPS POST**, which this adapter uses (no SOAP/XML client, no
WSDL codegen):

| Operation | Endpoint | Capability |
| --- | --- | --- |
| Create shipment (AWB) | `…/ShippingAPI.V2/Shipping/Service_1_0.svc/json/CreateShipments` | `CREATE_SHIPMENT` |
| Track shipment | `…/ShippingAPI/Tracking/Service_1_0.svc/json/TrackShipments` | `FETCH_STATUS` + auth probe |
| Calculate rate | `…/ShippingAPI.V2/RateCalculator/Service_1_0.svc/json/CalculateRate` | `FETCH_COST` |

**Auth.** Every request body carries a `ClientInfo` block:
`UserName`, `Password`, `AccountNumber`, `AccountPin`, `AccountEntity`
(3-letter origin branch, e.g. `CMN` = Casablanca), `AccountCountryCode`
(ISO-2), plus `Version` (`"1.0"`) and `Source` (small integer, default
`24`). The whole body is therefore a secret — the client never puts a
body, URL, or credential into a thrown or returned value (mirrors the
OzonExpress client's path-secrecy rule).

**Error signalling.** HTTP 200 with `{ "HasErrors": true, "Notifications":
[ { "Code", "Message" } ] }`. `assertNoApiError` in `client.ts` raises a
typed `DeliveryProviderError` from that; `errors.ts` maps the auth /
config / not-found message substrings and surfaces anything else as a
sanitised `DeliveryUnavailableError`.

**Request field names** come verbatim from Aramex's official sample
(`aramex/shipping-services-api-sample-code/createShipmentsPHP.txt`):
`Shipments[0].{Shipper,Consignee,Details}`, `Details.{ProductGroup,
ProductType,PaymentType,ActualWeight,DescriptionOfGoods,
CashOnDeliveryAmount,…}`, top-level `Transaction` and `LabelInfo`.

## Decision

### Capabilities
`CREATE_SHIPMENT`, `FETCH_STATUS`, `FETCH_COST`. Explicitly **not**:

- `CANCEL_SHIPMENT` — Aramex's cancel flow is pickup-scoped
  (`CancelPickup`), not AWB-scoped; no clean "cancel this waybill".
- `FETCH_CITIES` — Aramex addresses by free-text city + ISO country code,
  with no mandatory numeric city id, so the city-mapping layer
  (ADR 0018) is not needed. The order's city string is sent as-is.
- `GENERATE_MANIFEST` — no equivalent of OzonExpress's "bon de livraison"
  multi-step API in the JSON services we use.
- `WEBHOOKS` — Aramex push notifications need separate provisioning we
  don't have.

Undeclared capabilities hit the shared typed "unsupported" error, never a
silent local action.

### Origin (shipper) address in config, not per order
`CreateShipments` needs a full `Shipper` address + contact on every
shipment. These live once in the connector's non-secret config
(`shipperName`, `shipperPhone`, `shipperLine1`, `shipperCity`,
`shipperCountryCode`, plus `productGroup`/`productType`/`paymentType`,
`defaultWeightKg`, `defaultGoodsDescription`). `mapper.ts:resolveShipper`
throws a typed `DeliveryConfigError` **before any external call** when a
required piece is missing.

### Connection test creates nothing
`testConnection` runs one `TrackShipments` with an obviously-invalid
waybill (`"0000000000"`). Valid credentials → `HasErrors: false` +
`NonExistingWaybills`; invalid → `HasErrors: true` + an auth notification
→ typed `DeliveryAuthError`. The success detail also reports whether the
shipper address is complete, since that is the next thing the operator
needs.

### Cost
`CreateShipments` returns no price. `createShipment` makes a best-effort
`CalculateRate` call afterwards and reports `TotalAmount.Value`; a
failure there is swallowed (`cost: null`) and never fails an
already-created shipment. `fetchStatus` never estimates a cost.

### Status vocabulary — best-effort, not verified
`mapper.ts` has two tables: `UpdateDescription` text (normalised: lower,
accent-stripped, whitespace-collapsed) and a handful of well-known
`SHxxx` `UpdateCode`s. Anything unrecognised returns `null` from
`mapAramexStatus` and is preserved verbatim as `Shipment.providerStatusRaw`
— never guessed (ADR 0012, "Status synchronization"). The tables are a
best guess of Aramex's phrasing and must be reconciled against a real
end-to-end tracked shipment before Aramex is relied on in production.

### Dates
Aramex's JSON gateway accepts `/Date(<ms>)/` for `ShippingDateTime` /
`DueDate`; the adapter sends `now` for both.

## Files
```
src/lib/integrations/delivery/providers/aramex/
  types.ts    credential + config zod schemas, permissive response schemas
  client.ts   AramexClient — ClientInfo assembly, SSRF re-check, timeout,
              retry, HasErrors unwrapping; parseMoney
  errors.ts   errorForStatus / errorForNotifications → typed errors
  mapper.ts   buildCreateShipmentPayload, parseCreateShipmentResponse,
              parseTrackingResponse, buildCalculateRatePayload,
              parseCalculateRateResponse, mapAramexStatus, buildTrackingUrl
  adapter.ts  aramexAdapter (DeliveryProviderAdapter), ARAMEX_VERIFICATION
  index.ts    registerAramexProvider()
```
Registered from `src/lib/integrations/delivery/providers/index.ts`.
Operator setup guide: `src/components/delivery/delivery-docs.tsx`
(`AramexGuide`). Tests: `tests/lib/aramex-mapper.test.ts`,
`tests/lib/delivery-production-registry.test.ts`.

## Consequences
- Aramex is selectable in "Livraison → Prestataires" and can be
  configured + connection-tested. Saving credentials → CONFIGURE; only a
  successful real test → CONNECTE (unchanged from ADR 0012/0013).
- The status table and the exact `CreateShipments` response shape remain
  unverified. First real shipment must be checked end to end and this ADR
  amended with an addendum like ADR 0013's.
- Adding a third carrier is still just another adapter directory + one
  `register…Provider()` line.
