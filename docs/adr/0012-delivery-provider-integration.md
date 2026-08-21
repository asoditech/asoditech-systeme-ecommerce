# ADR 0012 — Delivery provider integration (Phase 22)

## Status
Accepted (2026-08-21)

## Context
`docs/adr/0006-delivery-providers.md` established `ShippingProvider`/
`Shipment` and left "any real carrier API integration" explicitly
deferred: "its adapter would live in a new `src/lib/delivery/<provider>.ts`
implementing a common interface (not yet defined, since there's no second
real implementation to generalize from)." Phases 20–21 have since built
exactly that kind of interface twice, for WooCommerce and Shopify (see
`docs/adr/0010-woocommerce-integration.md`, `docs/adr/0011-shopify-integration.md`),
and factored the provider-agnostic parts into `src/lib/integrations/shared/`.
This phase generalizes that same pattern to delivery carriers.

No delivery carrier is named anywhere in this project's ADRs, README, or
code — a `grep` for known Moroccan/international carrier names across the
repo before this phase turned up nothing. This matters: `docs/adr/0004`'s
own reasoning for leaving Meta/Google/TikTok/WhatsApp/Email/Sheets/AI as
boundary-only applies identically here — "building one without a live
account to test against would produce untested, likely-broken code, worse
than not building it." Guessing a carrier (its auth scheme, request shape,
status vocabulary, whether it supports COD, whether it has a stable
webhook contract) would be inventing business context that isn't this
system's to invent — it's a vendor/contract decision for ASODITECH's
operator. See "Provider selection" below.

## Decision

### Architecture — generic first, no provider baked in
```
src/lib/integrations/delivery/
  types.ts       DeliveryProviderAdapter interface, capability model
  errors.ts      DeliveryProviderError hierarchy (mirrors woocommerce/errors.ts)
  registry.ts    key -> adapter map; assertCapability()
  service.ts     orchestration: connect/test/create/cancel/sync/webhook,
                 all DB writes and error normalization
  providers/
    index.ts     production bootstrap — imports real adapters. Empty today.
```
This mirrors `src/lib/integrations/woocommerce/` and `.../shopify/`
structurally (client/errors/mapper/ssrf/webhook-signature split), reusing
`src/lib/integrations/shared/` directly rather than re-implementing SSRF
host validation (`assertPublicHost`) or webhook HMAC verification
(`verifyHmacSha256Base64`) a third time.

`DeliveryProviderAdapter` (`types.ts`) declares `capabilities:
DeliveryCapability[]` (`CREATE_SHIPMENT` / `CANCEL_SHIPMENT` /
`FETCH_STATUS` / `FETCH_COST` / `WEBHOOKS`) and implements only the
optional methods it actually supports; every optional method stays
`undefined` on an adapter that doesn't implement it. `registry.ts`'s
`assertCapability()` throws `DeliveryUnsupportedCapabilityError` — a typed
"not supported" result — for any operation attempted against a capability
the adapter didn't declare, rather than a method existing but silently
pretending to succeed. `FETCH_COST` deliberately has no dedicated adapter
method — cost rides along on `createShipment`'s and `fetchStatus`'s own
result, since every real carrier API that returns a cost returns it
alongside the resource it was already fetching, not via a separate call.

**Deliberately not modeled as a capability**: updating an already-created
shipment's address/notes after submission. No method, action, or UI exists
for it in this phase — most carriers don't support post-creation edits,
and the pre-existing MANUEL flow doesn't offer this either. Add it (method
+ capability + action + UI, together) only when a real provider's API
documents genuine support.

### Provider selection — the owner decision this phase surfaces
Per the phase brief's own instructions for this exact situation ("if no
provider is specified... build the generic abstraction... implement only a
provider whose contract can be verified... if an owner-level choice is
genuinely required, stop only at that decision after completing all
provider-independent work"), this phase:
1. Built and tested the full generic abstraction, registry, DB schema,
   connection lifecycle, and UI (all below) — all genuinely usable the
   moment a real adapter is registered, no further schema change needed.
2. Did **not** invent a specific carrier adapter.
3. Built one **fixture adapter** (`tests/helpers/reference-delivery-provider.ts`,
   key `__test_reference__`, display name prefixed `[TEST]`) purely to
   prove the abstraction end-to-end — registry, Server Actions, RBAC,
   audit, concurrency, webhook signature/replay — against the real test
   database, the same way `tests/helpers/fake-woocommerce.ts` proves the
   WooCommerce adapter without a live store. It is registered **only** from
   test code (`registerReferenceDeliveryProvider()`), never imported by
   `providers/index.ts`, so it cannot reach a production build — verified
   by `pnpm build`'s route/bundle output containing no reference to it.
4. `src/lib/integrations/delivery/providers/index.ts` is therefore empty
   in production today. `listAvailableDeliveryConnectors()`
   (`src/lib/queries/delivery.ts`) reflects that honestly: the "Configurer"
   UI (below) shows zero connectors and stays disabled rather than
   offering a fake one.

**Owner decision needed**: which delivery carrier(s) to integrate first.
Once chosen, implementing it is additive: a new
`src/lib/integrations/delivery/providers/<carrier>/` adapter (client +
errors + mapper + ssrf, following the woocommerce/shopify file layout),
one line registering it in `providers/index.ts`, and its `providerKey`
becomes selectable in the existing "Configurer" UI — no schema migration,
no new Server Action, no new UI screen.

### Database — additive to ShippingProvider/Shipment, no new registry table
Delivery providers are deliberately **not** modeled as `Integration` rows
— `docs/adr/0006` already established `ShippingProvider` as delivery's own
registry, independent of the `IntegrationProvider` enum (which has no
delivery member and shouldn't grow one just to reuse `Integration`'s
credential column). Instead, `ShippingProvider` gained the same fields
`Integration` has for exactly the same reason, reusing `IntegrationStatus`
(`DECONNECTE`/`CONFIGURE`/`CONNECTE`/`ERREUR`) itself rather than a
duplicate enum:

| Field | Meaning |
| --- | --- |
| `providerKey` | Which registered adapter handles this row. `null` unless `type = API`. |
| `connectionStatus` | `IntegrationStatus?` — `null` for MANUEL/FLOTTE_INTERNE (not applicable, not "disconnected"). |
| `credentialsEncrypted` | AES-256-GCM ciphertext via `src/lib/crypto.ts` (same mechanism, same key, as `Integration.credentialsEncrypted`) — never returned to the client. |
| `capabilities` | Snapshotted from the adapter on successful connection test, for UI use. |
| `lastConnectionCheckAt` / `lastSyncAt` / `lastError` | Same meaning as their `Integration` counterparts. |

`Shipment` gained `externalId` (the provider's own shipment id — required,
never fabricated), `providerStatusRaw` (last raw status string, preserved
even when unmapped), and `lastSyncedAt`. `@@unique([providerId,
externalId])` (Postgres allows multiple `NULL`s, so MANUEL/FLOTTE_INTERNE
shipments, whose `externalId` is always `null`, are never restricted) —
same pattern as `Order`'s `@@unique([source, externalId])` from
`docs/adr/0010`.

`ShipmentWebhookEvent` mirrors `WebhookEvent`'s exact shape and
replay-protection guarantee (`@@unique([providerId, deliveryId])`) but FKs
to `ShippingProvider` instead of `Integration`, since delivery providers
aren't `Integration` rows. No raw webhook payload is ever persisted, only
id/topic/resource id/outcome — identical to `WebhookEvent`.

Migration: `prisma/migrations/20260821162922_delivery_provider_integration/`.

### Connection lifecycle
Identical honesty rule to `docs/adr/0010`'s: saving credentials
(`configureDeliveryProviderApiAction`) always lands on `CONFIGURE`, never
`CONNECTE`. Only `testDeliveryProviderConnectionAction` — which performs
one real authenticated request via the adapter's `testConnection()` — can
set `CONNECTE` (success) or `ERREUR` (failure, with `lastError`). The UI
reuses `INTEGRATION_STATUS_LABELS` verbatim ("Connecté" / "Configuré (non
vérifié)" / "Erreur de connexion" / "Non configuré") — no new label set,
no risk of the two connection-status vocabularies drifting apart.

### Shipment creation
`createShipmentViaProviderAction` → `service.ts:createShipmentViaProvider`:
validates the order is in a shippable state (reuses the existing
`SHIPPABLE_ORDER_STATUSES` gate from `docs/adr/0006`'s audit addendum) and
that the order's shipping address is complete (line 1, city, country —
`OrderAddressIncompleteError` otherwise, before any provider call).
Creates a local `Shipment` row first (`EN_ATTENTE`, no `externalId`) so
the adapter has a stable local id to key an idempotency request off of if
the carrier supports one, then calls the adapter. **The row is only ever
updated after that call resolves — never a second row for a retry.** On
provider success, it's updated with exactly what the provider returned
(`externalId`, `trackingNumber`, `trackingUrl`, `cost` — any of the latter
three genuinely `null` if the provider's response didn't include it, never
guessed). On provider failure (rejection, malformed response, timeout),
the same row is marked `ECHEC` with the safe error message — never left
looking like an ordinary pending shipment, never silently deleted.

**Double-submit guard**: `createShipmentViaProviderAction` refuses a
second create for the same `(orderId, providerId)` pair while an active
(`EN_ATTENTE`/`EN_TRANSIT`) shipment already exists there — closes the
common case (double-click, accidental resubmit) of two real-world parcels
from one order. This is a pre-check, not a DB-level constraint (Postgres
has no simple partial-unique-index expression in this schema for "at most
one active shipment per order+provider" without a raw, unmanaged index),
so a genuinely simultaneous pair of requests can still both pass the
pre-check before either commits — verified directly by a `Promise.all`
concurrency test (`tests/actions/delivery-provider.test.ts`), which
asserts at most one of the two ever succeeds *in practice* against the
real test database, not that the race is mathematically impossible. Closing
this fully needs either a real provider's idempotency key (adapter-specific,
can't be built generically without one) or a Postgres partial unique index
added as a deliberate follow-up — listed under Deferred.

### Cancellation
`cancelShipmentAction` calls the adapter's `cancelShipment()` **first**;
only on success does it run `applyShipmentStatusTransition` (below) to
`ANNULE`. A carrier that rejects the cancel request leaves the local
shipment exactly as it was, with the carrier's own reason surfaced to the
user — never a local cancellation that isn't reflected on the carrier's
side.

### Status synchronization
`src/lib/delivery.ts:applyShipmentStatusTransition()` is now the **one**
place `Shipment.status` is written — extracted from the pre-existing
`updateShipmentStatusAction` (manual staff transitions) so provider-driven
synchronization (`syncShipmentStatus`, and any future webhook) reuses the
identical transition-table check, concurrency-safe conditional update
(`docs/adr/0002`'s audit addendum pattern), and `LIVRE → order LIVREE`
auto-advance rule (`docs/adr/0006`'s audit addendum) instead of a second,
possibly-diverging implementation. No additional automatic order
transitions were added for `ECHEC`/`RETOURNE` — same reasoning as
`docs/adr/0006`: those need staff judgment.

Provider status mapping is **adapter-owned** (`adapter.mapStatus(raw)`),
exactly like `woocommerce/mapper.ts:mapOrderStatus` — never a shared guess
table, since different carriers use unrelated vocabularies. A raw status
the adapter doesn't recognize is preserved verbatim in
`Shipment.providerStatusRaw` and reported as `unknown_status` to the
caller; the local `ShipmentStatus` is left untouched rather than guessed.
If the mapped status isn't a valid transition from the shipment's current
local status (e.g. staff already moved it on manually), the raw
status/sync timestamp are still recorded but no transition is forced.

Sync is **manual/polling only** in this phase — a per-shipment
"Synchroniser" button (`syncShipmentStatusAction`). See "Webhooks" below
for why no live push path exists yet.

### Delivery cost
Only ever the provider's own returned figure, stored on the pre-existing
`Shipment.cost` — never estimated, never defaulted to `0`. This is the
same column MANUEL shipments already use for staff-entered cost, so
`getFinanceSummary()`'s `deliveryCostTotal` (`src/lib/queries/finance.ts`,
`docs/adr/0007`) needs no change and can't double-count: one `Shipment`
row, one `cost` value, one source (provider or staff) at a time. Unlike
COGS's all-or-nothing null-propagation, this total is a plain sum where a
`null` cost contributes nothing rather than requiring the whole total to
go `null` — that's pre-existing `deliveryCostTotal` behavior from before
this phase (MANUEL shipments have always been able to omit cost), not a
new decision.

`Order.shippingCost` (customer-paid shipping, set at order creation) and
`Shipment.cost` (what the carrier actually charges/charged this business)
remain the two distinct figures `docs/adr/0002`/`0007` already established
— this phase doesn't blur them or introduce a third.

### Webhooks — plumbing built and tested, no live route
`service.ts:handleDeliveryWebhook()` implements the full
"webhook → verify signature → replay-protect → authoritative fetch →
shared update pipeline" flow `docs/adr/0010`'s Phase 21 addendum
recommends, reusing `syncShipmentStatus` for the actual update so there is
exactly one status-mapping/update code path for both manual sync and
webhook-triggered sync. It is fully exercised by
`tests/lib/delivery-service.test.ts`, including a genuine concurrent
duplicate-delivery `Promise.all` test (mirroring the race
`docs/adr/0010`'s Phase 21 addendum found and fixed for WooCommerce/
Shopify) proving `ShipmentWebhookEvent`'s unique constraint — not
apologetic hoping — is what prevents a double-processed delivery.

**No `src/app/api/webhooks/delivery/...` HTTP route exists.** With zero
production adapters registered, no real carrier could ever call one — an
unreachable public endpoint is exactly the "fake integration to make the
UI look complete" the brief prohibits. Once a real provider is chosen and
does support webhooks, its route is a thin wrapper: read the raw body,
call `handleDeliveryWebhook()`, map the outcome to an HTTP status — all
the actual logic already exists and is tested.

### RBAC and audit
No new permissions — `delivery.view`/`delivery.manage` already express
exactly the read/mutate boundary every new action needs (provider
configuration and shipment mutation both gated on `delivery.manage`,
enforced server-side in every action via `requirePermissionForAction`,
never only hidden in the UI). New `AuditAction` members follow the
existing `entity.verb` convention already used for `shipment.*`/
`shipping_provider.*` (not a new `delivery.*` namespace):
`shipping_provider.api_configured`, `shipping_provider.connection_test_succeeded`/
`_failed`, `shipment.creation_failed`, `shipment.cancelled`/
`_cancellation_failed`, `shipment.status_sync_failed`. No credential,
token, or signature ever appears in audit metadata.

### UI
Livraison page, "Prestataires" tab: new "Connexion" column
(`ProviderConnectionStatus`, API-type rows only) and, when `canManage`, a
"Configurer" control (`ProviderConnectionControls`) — disabled with no
dialog content beyond an honest "Aucun connecteur... disponible" message
when the registry is empty (today, in production), populated with a real
connector picker + credentials form the moment one is registered.
"Tester la connexion" only appears once a connector is actually selected.
"Expéditions" tab gained a cost column and, for API-created shipments
(`externalId` set), inline "Synchroniser"/"Annuler" controls
(`ShipmentProviderControls`). `CreateShipmentDialog` branches on the
selected provider's `type`: MANUEL/FLOTTE_INTERNE keeps the existing
manual tracking/cost fields; API shows a "supplied by the connector" note
instead and is disabled until that provider is actually `CONNECTE`. All
labels French, all reusing existing status-label maps
(`INTEGRATION_STATUS_LABELS`, `SHIPMENT_STATUS_LABELS`) — no new label
vocabulary introduced.

## Test matrix
`tests/lib/delivery-registry.test.ts` (registry/capability behavior),
`tests/lib/reference-delivery-provider.test.ts` (fixture adapter against a
fake HTTP carrier — auth failure, malformed response, timeout, SSRF on a
private-IP config, webhook signature verify/reject), `tests/lib/delivery-service.test.ts`
(connection lifecycle, shipment creation incl. address validation/provider
rejection/malformed response/timeout all resulting in `ECHEC` never a fake
success, cancellation, status sync incl. unknown-status/idempotency/order
auto-advance, webhook processing incl. replay protection and a genuine
concurrent-duplicate-delivery `Promise.all` test), `tests/actions/delivery-provider.test.ts`
(Server Action-level: RBAC denial, audit events, credentials never
returned to the client, the double-submit concurrency guard via
`Promise.all`). 52 new tests, all passing; 267/267 total.

## Deferred (explicitly, not silently)
- **A real carrier adapter.** See "Provider selection" — an owner decision,
  not a technical gap.
- **A live webhook HTTP route.** See "Webhooks" — built and tested, not
  wired to a public URL with nothing that could call it.
- **Full DB-level prevention of concurrent duplicate shipment-create
  requests.** The pre-check guard narrows this to the common case; closing
  it completely needs either a real provider's idempotency key or a
  Postgres partial unique index — see "Shipment creation".
- **Post-creation shipment updates** (address/notes after submission) —
  see "Architecture".
- **Multiple concurrent API-connected providers of the same carrier
  brand**, or per-provider rate-limit-aware retry policy — no real
  provider exists yet to know what's needed.

## Live verification
`LIVE_TESTED = NO`. No real delivery-carrier account/credentials exist in
this environment — everything above was verified against the real test
database with the fixture adapter and mocked HTTP responses, exactly like
`docs/adr/0010`/`0011`'s own stated limitation before a live WooCommerce/
Shopify store was available.
