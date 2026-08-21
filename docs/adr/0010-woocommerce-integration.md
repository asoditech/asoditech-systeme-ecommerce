# ADR 0010 — WooCommerce integration (Phase 20)

## Status
Accepted (2026-08-21)

## Context
Phase 19 established this system as `READY_FOR_INTEGRATIONS`. This phase
implements the first real external integration — WooCommerce — per
`docs/adr/0004-integration-architecture.md`'s plan. `ADR 0004`'s original
scaffold (credential storage only, `status = CONNECTE` meaning "credentials
saved") is superseded by this ADR wherever the two disagree; this document
is the current source of truth for WooCommerce, and 0004 remains the
source of truth for the other, still-scaffolded providers.

Authentication, pagination headers, and the webhook signature algorithm
below were verified against WooCommerce's own documentation and core
source (`class-wc-webhook.php`) during this phase rather than assumed from
memory — see the inline citations.

## Architecture

```
Browser
  ↓ (Server Action, session-authenticated, permission-checked)
src/actions/woocommerce.ts
  ↓
src/lib/integrations/woocommerce/sync/*   (orchestration, DB writes)
  ↓
src/lib/integrations/woocommerce/client.ts (auth, pagination, retry, error mapping)
  ↓ HTTPS + HTTP Basic Auth
WooCommerce REST API v3
```

```
WooCommerce  → (webhook, HMAC-signed) → src/app/api/webhooks/woocommerce/route.ts
                                            ↓
                                  same sync/orders.ts import logic
```

The browser never talks to WooCommerce directly, in either direction —
every write and read goes through a Server Action or the webhook route,
both server-only.

### File layout
- `client.ts` — the only place that constructs a WooCommerce request:
  Basic Auth header, base URL, 15s timeout via `AbortController`, retry
  with backoff on network errors/429/5xx (respecting `Retry-After`),
  pagination via `page`/`per_page` and the `X-WP-TotalPages` response
  header, and safe error normalization (never a raw response body or
  request URL in a thrown error).
- `types.ts` — Zod schemas for the WooCommerce response shapes actually
  used. External JSON is never trusted directly; every response is parsed
  through one of these before being mapped into a Prisma shape.
- `errors.ts` — `WooCommerceError` subclasses (`Config`, `Auth`,
  `Permission`, `NotFound`, `Timeout`, `RateLimit`, `Unavailable`,
  `MalformedResponse`), each carrying only a safe, French, user-facing
  message.
- `mapper.ts` — pure functions (no I/O) mapping validated WC data to
  internal shapes, including the order-status and payment-method mapping
  tables.
- `ssrf.ts` — `validateStoreUrl()`, the SSRF guard (see below).
- `webhook-signature.ts` — HMAC-SHA256 verification and secret generation.
- `sync/` — orchestration: `categories.ts`, `products.ts` (products +
  variations + the stock-pull half of inventory sync), `stock-push.ts`
  (the stock-push half), `orders.ts` (shared by the manual sync action
  and the webhook route), `actor.ts` (who triggered a write, for audit
  attribution), `types.ts` (the honest `SyncSummary` shape).
- `src/actions/woocommerce.ts` — the Server Actions: test connection,
  sync products, sync orders, push stock, generate webhook secret.
- `src/app/api/webhooks/woocommerce/route.ts` — the one route in this app
  authenticated by a shared secret instead of a session.

No new dependency was added — the client uses the platform `fetch`.

## Authentication
HTTP Basic Auth over HTTPS, per WooCommerce's own docs: "You may use HTTP
Basic Auth by providing the REST API Consumer Key as the username and the
REST API Consumer Secret as the password." Plain-HTTP stores are rejected
outright — WooCommerce's docs state HTTP requires OAuth 1.0a "one-legged"
authentication instead, which this phase deliberately does not implement
(a second auth scheme for a discouraged, insecure transport isn't worth
the complexity here). Credentials are never placed in the URL/query string
even though WooCommerce supports that as a fallback — only the header.

## Credential security
Reuses the existing `Integration.credentialsEncrypted` (AES-256-GCM,
`src/lib/crypto.ts`) rather than adding a new secret-storage mechanism.
For WooCommerce the encrypted JSON blob is `{ apiKey, apiSecret,
webhookSecret }` — `apiKey`/`apiSecret` are WooCommerce's own field names
kept from the pre-existing generic connect form (avoids reshaping that
form/schema for one provider); `webhookSecret` is added by "Générer un
secret webhook".

**Webhook secret reveal — a deliberate, narrow exception.** Consumer
key/secret (used to *call* WooCommerce) are never returned to the client,
full stop. The webhook secret is the opposite trust direction: it's a
value *this system generates* for WooCommerce to send back to us, and the
operator must relay it into WooCommerce admin by hand (see "Webhooks"
below — registration is manual, not API-driven, in this phase). It is
therefore returned once, in the direct response of
`generateWooCommerceWebhookSecretAction`, and never retrievable again —
only its encrypted form is stored thereafter. This is the same
reveal-once pattern used for any issued API credential (Stripe, GitHub,
AWS), not a weakening of the "never expose credentials" rule, which is
about *our* outbound credentials.

### SSRF protection
`ssrf.ts:validateStoreUrl()` runs at connect time and again immediately
before every request-issuing action (`testWooCommerceConnectionAction`,
every sync action) — DNS can change between the two. It rejects: non-HTTPS
URLs, embedded credentials in the URL, `localhost`/`*.local`, and any
hostname whose resolved address (checked via `dns.lookup` with `all:
true`, so every returned address is checked, not just the first) falls in
a private/loopback/link-local/reserved range (RFC1918, loopback,
169.254.0.0/16 — including the cloud metadata address
`169.254.169.254` — and CGNAT). A literal IP is checked directly without a
DNS round trip. Re-checking before every request (not just at save time)
is what closes the DNS-rebinding variant of this attack.

## Connection lifecycle
`IntegrationStatus` gained a fourth value, `CONFIGURE`, precisely to close
the gap `ADR 0004`'s audit addendum flagged: **saving credentials no
longer implies a live connection.**

| Status | Meaning |
| --- | --- |
| `DECONNECTE` | Never configured, or explicitly disconnected. |
| `CONFIGURE` | Credentials saved, never (or not since) successfully verified. |
| `CONNECTE` | The most recent "Tester la connexion" request actually succeeded. |
| `ERREUR` | The most recent connection test or sync attempt failed. |

`connectIntegrationAction` (shared with the other, still-scaffolded
providers) now always lands on `CONFIGURE`, not `CONNECTE` — this closes
the audit finding for every provider, not just WooCommerce.
`testWooCommerceConnectionAction` is the **only** path that can set
`CONNECTE`, and it does so only after a real authenticated
`GET /orders?per_page=1` succeeds. Every sync action also updates status
(`CONNECTE` on success, `ERREUR` on failure) and `lastError`/
`lastConnectionCheckAt`/`lastSyncAt` as appropriate. The UI
(`WooCommerceCard`) renders all four states with distinct labels — no
green "Connecté" badge is ever shown from credential-save alone.

## Resource mapping, ownership, and sync direction

| Resource | Direction | Notes |
| --- | --- | --- |
| Categories | WooCommerce → System | Matched by `(source, externalId)`; a slug collision against an unrelated category is never silently adopted — the incoming slug is suffixed instead. |
| Products (+ variations) | WooCommerce → System | See field ownership below. |
| Inventory | **Both**, but never automatically both at once | Pull: reconciled as part of product sync. Push: a separate, explicit "Pousser le stock" action. |
| Orders | WooCommerce → System, always | The internal order state machine remains authoritative for everything that happens to an order *after* import. |
| Customers | WooCommerce → System | Derived from order billing/shipping, not a standalone `/customers` sync (see below). |

None of these directions were chosen because the API technically permits
them — see the reasoning for each below.

### Field ownership (products/categories)
For a `source = WOOCOMMERCE` record, WooCommerce owns and overwrites on
every sync: name, sku, description, price, salePrice, status,
trackInventory, categoryId (products); name, slug, description, parent
(categories); attributes, price (variations). **Never touched by sync,
even on an update:** `Product.cost`/`ProductVariation.cost` (WooCommerce
has no cost field — this stays internal-only, preserving the existing
COGS-honesty model in `docs/adr/0007-finance-and-profit.md`),
`Product.lowStockThreshold` (an internal management setting),
`Customer.segment`/`tags`/`notes` (per `docs/adr/0002`, manually-set only).
`INTERNE`-sourced records are never touched by any sync path — only rows
already carrying `source = WOOCOMMERCE` are matched and written.

WooCommerce lets a product belong to multiple categories; the internal
schema has one `categoryId` FK, so only the first category is used — a
deliberate, documented simplification, not silent data loss.

### Why products/categories are WooCommerce → System, not the reverse
The storefront already lives on WooCommerce; this system is the
management/back-office layer that needs the catalog to reconcile orders,
inventory, and finance against. Exporting internally-authored products
*to* WooCommerce would require deciding a second source of truth for the
same catalog with no clear conflict-resolution rule — deferred, not built
speculatively.

### Inventory — the bidirectional resource, made precise
The existing reserve/fulfill/release/return/adjust engine
(`src/lib/inventory.ts`) is entirely preserved. Two separate, always
explicit, always one-directional-per-run operations sit on top of it:

- **Pull** (`sync/stock.ts:reconcileStockFromWooCommerce`, run as part of
  product sync): on first sight of a product/variation, the WooCommerce
  stock snapshot *initializes* `InventoryItem.quantityOnHand` directly —
  not a business event, exactly like `createProductAction`'s own
  `quantityOnHand: 0` seed with no movement. On every later sync, if the
  snapshot disagrees with the current internal quantity, an explicit
  `AJUSTEMENT_POSITIF`/`AJUSTEMENT_NEGATIF` movement is recorded (reason:
  "Synchronisation WooCommerce") plus an `inventory.reconciled` audit
  event — the difference is always accounted for, never silently
  overwritten, and nothing is fabricated merely because a read happened
  (equal values write nothing at all).
- **Push** (`sync/stock-push.ts`, the "Pousser le stock" action): reads
  current internal **sellable** stock (`quantityOnHand -
  quantityReserved` — units already reserved against a local order must
  not appear purchasable on the storefront) for WooCommerce-linked
  products only, and `PUT`s it. This never writes to the internal
  database — nothing changed on our side, so no movement is created.

**Why this can't loop:** both directions are manually-triggered, one-shot
actions in this phase — there is no automatic poll-then-push cycle. The
only "always-on" WooCommerce → System path is the order webhook, which
carries order data, not stock snapshots; this system does not subscribe
to any stock-changed webhook (WooCommerce doesn't offer one as a stable
topic), so a push can never be read back and misinterpreted as an
independent external change.

**Why orders don't also drive the reservation ledger.** A WooCommerce
order's stock impact already happened on WooCommerce's side before it's
ever imported here. `importOrder` deliberately never calls
`reserveStockForOrder`/`fulfillStockForOrder` — that impact is reflected
into this system via the stock-pull reconciliation described above, not
by re-running the internal ledger a second time against the same units
(which would double-count). The known, accepted consequence: if the same
physical product is also sold through orders created *directly* in this
system, stock can drift between two live sync runs — true real-time
cross-channel stock locking is out of scope for this phase and is listed
under Deferred.

### Orders
Every WooCommerce order maps to `Order.source = WOOCOMMERCE`,
`externalId = <wc id>` (unique together — see Idempotency), `externalNumber
= <wc number>` (display only, since WooCommerce's `number` can differ from
its `id`). Line items resolve `productId`/`variationId` via
`(source=WOOCOMMERCE, externalId)`; when no match exists (product not yet
synced, or later removed), the item is still recorded with
`productId: null` and the name/SKU straight from WooCommerce's own line
item — never invented — with `costSnapshot: null` (honest: COGS on that
line becomes "Non calculable" downstream, exactly the existing finance
rule). A re-import (webhook `order.updated`, or a later manual sync) never
rewrites line items — only order-level fields (totals, customer snapshot,
notes, refund state, and status where the transition is valid).

**Order-status mapping** (`mapper.ts:mapOrderStatus`) — every WooCommerce
core status is mapped explicitly; nothing is guessed:

| WooCommerce | Internal `OrderStatus` |
| --- | --- |
| `pending`, `on-hold` | `NOUVELLE` |
| `processing` | `CONFIRMEE` |
| `completed` | `LIVREE` |
| `cancelled` | `ANNULEE` |
| `refunded` | `REMBOURSEE` (+ a `Refund` row, see below) |
| `failed` | `ECHEC` |
| `checkout-draft`, `auto-draft`, `trash` | Never imported (not real orders) |
| anything else (a third-party plugin status) | **Skipped**, reported by name in the sync summary — never guessed |

On re-import, if the mapped target status isn't a valid transition from
the order's current internal status (e.g. staff already progressed it
past what WooCommerce reports, or the transition table simply disallows
it), the status field alone is skipped — the rest of the refreshed data
still commits — and the sync summary reports why. The internal state
machine (`docs/adr/0002`) is never bypassed to force a sync through.

**Refunds.** A WooCommerce order carrying refunds gets one internal
`Refund` row (`source = WOOCOMMERCE`, `status = COMPLETE`, amount = the
sum of WooCommerce's own refund totals) — created once, then kept in sync
by amount on later re-imports rather than duplicated. `paymentStatus`
is only forced to `REMBOURSE` when WooCommerce's own order `status` is
`refunded` (a genuine full refund signal); a partial refund on an
otherwise-active order creates the `Refund` row (so Finance nets it out
correctly per `docs/adr/0007`) without touching `paymentStatus`. This
still satisfies the invariant from `docs/adr/0003`'s audit addendum
(`paymentStatus = REMBOURSE` only ever alongside a real completed
`Refund`) — the import path creates both together, atomically.

**Payment method** — only WooCommerce's four built-in gateways (`cod`,
`bacs`, `cheque`, `paypal`) are mapped explicitly; any third-party gateway
id (Stripe, a local processor, …) maps to `AUTRE` rather than guessed.

### Customers
Deliberately **not** a standalone `/customers` sync. WooCommerce's
`/customers` endpoint only covers registered accounts, and a large share
of realistic orders are guest checkouts (`customer_id: 0`) identified only
by billing e-mail — a separate customer-only sync would miss exactly
those. Instead, every order import resolves (and if needed creates) its
`Customer` as a side effect: a registered WooCommerce customer is matched
by `(source=WOOCOMMERCE, externalId=<wc customer_id>)`; a guest is matched
by `(source=WOOCOMMERCE, email)` when an email is present. Matching is
always on a real external identifier — **never** on fuzzy name similarity,
which could silently merge two unrelated people. `fullName`/`email`/
`phone`/`city`/`region`/`country` are refreshed on every match;
`segment`/`tags`/`notes` are never touched (manually-set only, per
`docs/adr/0002`).

## Idempotency and concurrency
Every create path is matched-then-created against `(source, externalId)`,
and the highest-risk one — `Order`, which can be written by both the
order webhook and a concurrent manual "Synchroniser les commandes" click
— now has a **DB-level unique index on `(source, externalId)`**
(migration `20260821090500_order_external_id_unique`; Postgres allows
multiple `NULL`s in a unique index, so `INTERNE` orders, whose
`externalId` is always `null`, are never restricted). `importOrder` wraps
its create path in try/catch and, on the resulting P2002, treats it as
"someone else just created it" and falls through to the update path
instead of surfacing a failure — the same defense-in-depth pattern
established during the A–G audit (`isUniqueConstraintError`, see
`docs/adr/0002`'s audit addendum). Verified with a genuine
`Promise.all([...])` concurrency test in `tests/actions/woocommerce.test.ts`,
not just reasoned about.

Running any sync twice against unchanged WooCommerce data writes nothing
new — every sync function reports `unchanged` rather than silently
no-op'ing, so the distinction is visible in the UI and `SyncRun` row.

## Sync engine and honest reporting
Every sync (`SyncSummary`, `sync/types.ts`) buckets every item it touched
into exactly one of `imported` / `updated` / `unchanged` / `skipped` /
`failed`, plus a capped list of human-readable notes (never a raw
external payload) — a sync is never reported as bare "success" merely
because the request was sent. `syncWooCommerceProductsAction` and
`syncWooCommerceOrdersAction`/`pushWooCommerceStockAction` each persist a
`SyncRun` row scoped to one `resource` string (`CATEGORIES`, `PRODUITS`,
`COMMANDES`, `STOCK_ENVOI`) with `direction` (`IMPORT`/`EXPORT`) and the
full imported/updated/unchanged/skipped/failed breakdown — a partial
failure lands on `PARTIEL`, not `SUCCES`, whenever anything succeeded
alongside a failure, and `ECHEC` when nothing did. All external HTTP calls
for a sync happen before any DB write begins (pages are fetched into
memory first, bounded at 200 pages/50 per page as a safety ceiling, not a
business limit); DB writes then happen per-item, so one item's failure
never rolls back items already committed in the same run.

## Webhooks
**Registered manually, not via the API.** `POST /wc/v3/webhooks` exists,
but this phase deliberately does not call it — auto-registration would
mean this system also owns the webhook resource's lifecycle on the
WooCommerce side (creating it, updating its URL if the app moves,
deleting it on disconnect, handling it going stale) for a one-time setup
action that takes an operator under a minute in WooCommerce admin. Instead,
`generateWooCommerceWebhookSecretAction` returns the target URL + a
generated secret once, and the operator pastes both into WooCommerce
admin → Réglages → Avancé → Webhooks, selecting topics "Commande créée"
and "Commande mise à jour".

**Supported topics: exactly `order.created` and `order.updated`.**
Nothing else — this is not a generic "accept any webhook" endpoint.
Product/category/customer webhooks are deferred (see below); orders are
the highest-value real-time case (a storefront sale should show up
promptly, not wait for the next manual/scheduled sync).

**Signature verification** — confirmed from WooCommerce core source
(`class-wc-webhook.php`, `generate_signature()`) rather than assumed:
```
X-WC-Webhook-Signature: base64_encode(hash_hmac('sha256', $raw_body, $secret, true))
```
`src/app/api/webhooks/woocommerce/route.ts` reads the exact raw request
body (`request.text()`, never a parse-then-restringify round trip, which
would change byte-for-byte formatting and break the comparison),
recomputes the same HMAC-SHA256/base64 value, and compares with
`crypto.timingSafeEqual`. A mismatch is a 401 with no further processing.

**Replay/idempotency.** `WebhookEvent` records `(integrationId,
deliveryId)` as a unique pair (WooCommerce's `X-WC-Webhook-Delivery-ID`
header) — a captured-and-resent request (a true replay) is rejected by
this check before any processing. A *legitimate* WooCommerce retry of a
delivery it considers failed gets a **new** delivery id and is therefore
reprocessed — but that's safe regardless, since order import is itself
idempotent by `(source, externalId)`. No raw webhook payload is ever
persisted, in `WebhookEvent` or anywhere else — only id/topic/resource
id/outcome.

**Unsupported topics are acknowledged (200), not rejected**, so
WooCommerce doesn't keep retrying a topic this system never intends to
handle, without turning the endpoint into a generic sink for arbitrary
events.

## Error handling
Every network/parsing failure is normalized to one of the eight
`WooCommerceError` subclasses in `errors.ts` before it can reach a Server
Action or the webhook route — invalid configuration, authentication
failure (401), permission failure (403), store/resource not found (404),
timeout, rate limit (429, exhausted after retry), store unavailable (5xx
or a network-level failure), and malformed response (non-JSON, or JSON
that fails the Zod schema). Every one of these carries a static, French,
safe message — never a raw exception message, response body, or the
request URL (which never contains credentials in the first place, since
auth is header-only). Order-status/payment-method mapping failures are
reported as a per-item `skipped` outcome with a named reason, never a
thrown error that aborts an entire sync run.

## Limitations and deliberately unsupported features
- **Real-time bidirectional stock locking** across this system's own
  internally-created orders and WooCommerce's live storefront sales.
  Both stock-pull and stock-push are explicit, one-shot actions in this
  phase; between two sync runs, the same product can still be oversold
  across both channels. A genuine fix needs either a stock-changed
  webhook (WooCommerce doesn't offer one as a stable topic) or a
  reservation-holding integration layer — out of scope here.
- **Product/category/customer webhooks.** Only order events are
  real-time; catalog and customer changes are picked up on the next
  manual "Synchroniser les produits" run. Deferred because catalog
  changes are lower-frequency and lower-stakes than missing a sale.
- **Programmatic webhook registration** via `POST /wc/v3/webhooks` — see
  above; registration is manual by design in this phase.
- **Multiple WooCommerce stores per instance.** `Integration.provider` is
  `@unique` — this system connects to exactly one WooCommerce store, in
  keeping with the one-Instance-per-client deployment model
  (`docs/adr/0002`).
- **Multi-category products.** Only the first WooCommerce category is
  used, per the single `categoryId` FK — documented above, not silent.
- **Tax-line-level detail.** Order `total_tax` is read but not broken
  down per tax class/jurisdiction — the internal `Order` model has no
  per-line tax breakdown to map it into.
- **OAuth 1.0a / plain-HTTP stores.** HTTPS + Basic Auth only.
- **Real live-store acceptance testing.** No live WooCommerce credentials
  were available in this environment — see the Phase 20 completion report
  for exactly what was and wasn't verified against a real store.

## Phase 21 addendum (Shopify integration)
When Shopify was implemented as the second integration, the
provider-agnostic pieces of this module (SSRF IP-range checks, HMAC
signature verification, `SyncActor`, the `SyncSummary` shape, and the
pull-side stock-reconciliation logic) were extracted into
`src/lib/integrations/shared/` and this module was refactored to call
them rather than keep its own copies — verified with a full test-suite
re-run showing zero regression. See
`docs/adr/0011-shopify-integration.md`.

That same phase's test matrix also required a genuine **concurrent
duplicate webhook delivery** test, which caught a real race in this
route: two simultaneous deliveries with the same delivery id could both
pass the "already seen?" check, then both attempt to create a
`WebhookEvent` row — the loser's insert, and the catch-block's own
fallback insert, both hit the `(integrationId, deliveryId)` unique
constraint uncaught, crashing the request instead of responding
gracefully. Fixed here (and in the Shopify route, which had the identical
pattern) via `shared/webhook-event.ts:recordWebhookEventOnce()`, which
treats that specific constraint violation as "a concurrent request
already recorded this delivery," not a failure.
