# ADR 0011 — Shopify integration (Phase 21)

## Status
Accepted (2026-08-21)

## Context
Phase 20 established the WooCommerce integration as this system's reference
architecture for external commerce providers — connection lifecycle
(`CONFIGURE`/`CONNECTE`/`ERREUR`), encrypted credential storage, the
`SyncRun`/`WebhookEvent` registry, the honest per-resource `SyncSummary`
shape, and the "never invent a mapping" discipline. This phase implements
Shopify as the second real integration, reusing every piece of that
architecture that is genuinely provider-agnostic, while building the
provider-specific pieces around Shopify's actual API model — which differs
from WooCommerce's in several load-bearing ways (see below).

Authentication, API version, GraphQL cost-based rate limiting, the
inventory/location model, order status enums, and webhook signing were
verified against Shopify's official developer documentation and, where the
docs excerpt was ambiguous or looked suspect, cross-checked a second time
during this phase rather than assumed from memory or carried over from the
WooCommerce ADR's REST-API mental model. See the inline citations below.

## Shared architecture (refactored out of WooCommerce, not duplicated)
During this phase, the following provider-agnostic pieces were extracted
from the WooCommerce integration into `src/lib/integrations/shared/` and
verified to introduce zero regression (full WooCommerce test suite re-run
after each extraction):
- `private-ip.ts` — the SSRF IP-range/DNS-resolution check
  (`assertPublicHost`). WooCommerce's `ssrf.ts` and Shopify's `ssrf.ts` each
  keep their own provider-specific URL-shape rules (WooCommerce: any HTTPS
  URL; Shopify: must be `*.myshopify.com`) and call this shared check for
  the actual private-address defense.
- `hmac.ts` — `verifyHmacSha256Base64`, the exact algorithm both
  WooCommerce (`X-WC-Webhook-Signature`) and Shopify
  (`X-Shopify-Hmac-SHA256`) use for webhook signing.
- `actor.ts` — `SyncActor`, attributing a sync/import to a real user or an
  automated integration for audit/inventory-movement purposes.
- `sync-summary.ts` — the honest `imported/updated/unchanged/skipped/failed`
  result shape every sync function returns.
- `stock-reconcile.ts` — `reconcileStockFromProvider`, the pull-side
  inventory reconciliation logic (initialize on first sight, explicit
  audited adjustment movement on disagreement, no-op when already equal).
  Extended in this phase to optionally persist a provider-native
  InventoryItem id (`externalItemId`) — see Inventory below.
- `webhook-event.ts` — `recordWebhookEventOnce`, added during this phase
  after a genuine concurrency test caught a real race (see Audit findings
  below) — both webhook routes now use it.

Each is a *reused implementation*, not a copy — a future third provider
gets these for free.

## What Shopify's actual API model requires that WooCommerce's didn't

### GraphQL Admin API, not REST
Verified during this phase: "The REST Admin API is a legacy API as of
October 1, 2024. Starting April 1, 2025, all new public apps must be built
exclusively with the GraphQL Admin API" — and Shopify's own current
reference documentation defaults to GraphQL examples throughout. Building
this adapter on REST (mirroring WooCommerce's approach) would mean
building on a path Shopify itself calls legacy. The adapter is therefore
GraphQL throughout: `src/lib/integrations/shopify/client.ts` POSTs
`{query, variables}` to
`https://<shop>.myshopify.com/admin/api/2026-07/graphql.json` with the
`X-Shopify-Access-Token` header (the same header name/mechanism is shared
between REST and GraphQL Admin API, confirmed from the docs) — 2026-07
being Shopify's current quarterly API version at the time of this phase.

**One deliberate, documented exception**: the webhook receiver. Shopify
webhook delivery bodies use the classic REST resource JSON shape
(snake_case, numeric ids — e.g. `financial_status: "paid"`,
`fulfillment_status: "fulfilled" | "partial" | null | "not_eligible"`),
verified separately from the general GraphQL-vs-REST decision above and
confirmed to be a **materially different, smaller status vocabulary**
than the GraphQL `OrderDisplayFinancialStatus`/`OrderDisplayFulfillmentStatus`
enums this adapter's mapping table is built around. Building and
maintaining a second, parallel REST-shaped mapping surface — with its own
enum table, its own address/line-item field names, its own money
formatting — would double the long-term maintenance and drift risk for a
payload this system only needs to react to, not deeply parse. Instead,
**the webhook is used purely as a trigger**: `src/app/api/webhooks/shopify/route.ts`
verifies the signature and reads only enough of the body to identify the
order (`id`, or `order_id` for `refunds/create`), converts it to the
equivalent GraphQL gid (`gid://shopify/Order/<id>`), and re-fetches that
order via `ShopifyClient.getOrder()` — running the result through the
exact same `importOrder` pipeline the manual sync uses. This guarantees
the webhook path can never map an order differently than a bulk sync
would, at the cost of one extra API call per webhook delivery — a
reasonable trade given webhook volume for one store is inherently low
relative to a bulk sync's own pagination cost.

### Authentication
`X-Shopify-Access-Token` header, generated by an existing Shopify **custom
app**. Verified during this phase: "You can no longer create new
admin-created custom apps" through the classic Shopify admin flow — new
custom apps must be created via the Shopify Dev Dashboard or CLI; existing
custom apps and their tokens remain fully functional. The connect UI's
copy reflects this accurately ("Utilisez le jeton d'accès Admin API d'une
application personnalisée Shopify existante") rather than describing a
setup flow that no longer exists for new stores.

### Host validation (`ssrf.ts`)
Verified from Shopify's own guidance: the Admin API should be called at
the shop's `<shop>.myshopify.com` domain, not a connected custom storefront
domain — so `validateShopDomain()` requires exactly that suffix (accepting
a bare shop name, a bare domain, or a full `https://` URL, normalizing to
`https://<shop>.myshopify.com`). This is simultaneously correct per
Shopify's API model *and* an inherent SSRF defense (a string can only
carry that literal suffix if it's genuinely under Shopify's own DNS
control — a crafted hostname like `internal.corp.myshopify.com` is
rejected by the shop-name regex, which disallows dots). The shared
DNS-resolution check still runs for defense-in-depth/consistency with
WooCommerce, though a genuine `*.myshopify.com` name will always resolve
publicly (confirmed: Shopify's DNS resolves arbitrary `*.myshopify.com`
subdomains regardless of whether that specific shop exists, routing
happens at their HTTP/TLS edge, not per-shop DNS records).

### Rate limiting — cost-based, not request-count
Verified from Shopify's official rate-limit docs: GraphQL Admin API uses a
calculated-query-cost bucket (points/second by plan tier, e.g. 100/s on
Standard, up to 1000-point single bucket), not WooCommerce's simple
request-count leaky bucket. A throttled response is a normal HTTP 200 with
a GraphQL `errors[].extensions.code === "THROTTLED"` entry, not an HTTP
429 (though 429/5xx are also retried with backoff as a defense-in-depth
fallback). Rather than pre-calculate query costs (Shopify's own
`currentlyAvailable` tracking requires reading the previous response,
which this adapter doesn't thread through the pagination generators),
`client.ts` reacts to a `THROTTLED` error with Shopify's own recommended
backoff ("the recommended backoff time is one second") and retries up to
3 times before surfacing `ShopifyThrottledError`.

### Connection lifecycle
Identical model to WooCommerce, reusing the same `IntegrationStatus`
enum (`CONFIGURE`/`CONNECTE`/`ERREUR`/`DECONNECTE`) established in Phase
20's audit fix — `connectIntegrationAction`'s Shopify branch always lands
on `CONFIGURE`; only `testShopifyConnectionAction`'s real
`locations(first: 1)` request can advance to `CONNECTE`.

### Webhook signing secret — the operator provides it, this system doesn't generate it
A genuine, load-bearing difference from WooCommerce. WooCommerce: this
system generates a webhook secret and the operator pastes it into
WooCommerce admin. Shopify: verified that the signature is computed with
"your app's client secret" — a value **Shopify itself generates** when the
custom app is created, shown on that app's own credentials page. This
system cannot generate or influence it. Consequently:
- The connect form's `apiSecret` field holds this client secret for
  Shopify (reusing the existing generic 3-field connect form rather than
  adding a fourth field) — and is **optional at connect time**, since an
  operator who only wants manual/periodic sync has no reason to provide
  it.
- There is no `generateShopifyWebhookSecretAction` (unlike WooCommerce's
  `generateWooCommerceWebhookSecretAction`) — nothing for this system to
  generate.
- Webhook subscriptions are still **registered manually** in Shopify
  admin/custom-app configuration (topics: Order creation, Order update,
  Order cancellation, Refund creation), for the same reasoning as
  WooCommerce's ADR 0010: avoiding this system owning a remote webhook
  resource's lifecycle for a one-time setup action.

## Product/variant mapping and field ownership
Every Shopify product has **at least one variant** — a hidden
"Default Title" variant even for non-configurable products (confirmed:
this is Shopify's actual data model, not an edge case). `isSimpleProduct()`
treats a product as "simple" (mapped directly onto the `Product` row, no
`ProductVariation`) only when it has exactly one variant titled
"Default Title" — otherwise every variant becomes its own
`ProductVariation` row, matching how this system's own manual product
creation already distinguishes simple vs. variable products. A variable
product's parent `Product` row still needs a non-null `price` (schema
requires it) — the lowest variant price is used as a conventional "from"
price, derived from real data, never fabricated.

Field ownership mirrors WooCommerce exactly: name/sku/description/price/
status/trackInventory are Shopify-owned and overwritten every sync;
**`cost` and `lowStockThreshold` are never touched**, even on an update —
verified by a dedicated test that sets both after first sync, re-syncs
with a changed Shopify price, and asserts they're untouched.

### Categories/taxonomy — deliberately not mapped
Shopify has no single-parent category tree comparable to this system's
`Category` model. Collections are many-to-many (a product can belong to
several); the newer standardized product taxonomy is a separate, evolving,
fixed global tree. Neither maps cleanly onto a single `categoryId` FK.
Rather than force a lossy mapping, **Shopify-sourced products get
`categoryId: null`** in this phase — a deliberate, documented decision
(see Deferred/decisions-requiring-input below), not silent data loss.

## Inventory: products, variants, inventory items, inventory levels, locations
Verified the real relationship chain: `Product` → `ProductVariant` →
`InventoryItem` (a distinct Shopify resource, one per variant) →
`InventoryLevel` (one per `InventoryItem` × `Location`) → `Location`. This
is a genuinely richer model than WooCommerce's single global stock number,
and this system's own schema already supports it — `Warehouse` already
modeled multiple locations; it just had no source/externalId to link one
to a real external location before this phase.

**Decision: each active Shopify `Location` becomes its own `Warehouse`
row** (`source=SHOPIFY`, `externalId=<location gid>`), never collapsed
into one number — `sync/locations.ts`. Inactive locations are skipped (not
imported), and the system's own existing default warehouse (used by
manually-created orders and any other provider) is never touched by this
sync (`isDefault` always `false` here).

Each variant's stock is then reconciled **per location** — `sync/products.ts`
walks every synced Warehouse and reads that variant's `InventoryLevel` at
that location's gid via `quantities(names: ["available"])` (confirmed
during this phase: `InventoryLevel.available` as a scalar field **does
not exist** in the current schema — it was replaced by the general
`quantities(names: [...])` API; using the old field name would have been
a real, silent bug). A variant not stocked at a given location is skipped
for that location, not treated as zero.

**A genuine bug found and fixed during self-review**: the mutation used to
push stock back (`inventorySetQuantities`) requires the Shopify
`InventoryItem` gid — a *third*, distinct Shopify resource from the
Product/Variant gid this system stores as `externalId`. The initial
implementation of the push path used the Product/Variant `externalId` by
mistake, which would have sent the wrong id to Shopify's mutation. Fixed
by adding `InventoryItem.externalId` (a new nullable column, this
system's own `InventoryItem` model, not Shopify's) — captured during the
pull-side reconciliation (`reconcileStockFromProvider`'s new optional
`externalItemId` parameter) and read back on push. WooCommerce needed no
equivalent field since its stock endpoint targets by product/variant id
directly, with no separate inventory-item concept.

### Push (System → Shopify): `inventorySetQuantities`
Verified this is the mutation Shopify's own docs recommend "if calling on
behalf of a system that acts as the source of truth for inventory
quantities" (as opposed to `inventoryAdjustQuantities`, meant for relative
deltas from an external event) — an absolute set, matching exactly what
"push current internal stock" means. `sync/stock-push.ts` batches up to 25
`(inventoryItemId, locationId, quantity)` entries per mutation call across
all Shopify-linked products/variations/warehouses, sending **sellable**
stock (`quantityOnHand - quantityReserved`), same reasoning as WooCommerce
— reserved units must not appear purchasable on the storefront. Nothing
is written internally by a push (no `InventoryMovement` fabricated).

### No sync loops
Both directions are explicit, manually-triggered, one-shot actions in
this phase — there is no automatic poll-then-push cycle. The only
always-on Shopify → System path is the order webhook, which carries order
data, not stock snapshots, and this system doesn't subscribe to any
inventory-level webhook — so a push can never be read back and
misinterpreted as an independent external change.

## Order/refund mapping
### Two independent status dimensions, not one field
Verified the exact, complete enum sets (re-checked directly against
Shopify's schema reference after an initial automated summary looked
internally inconsistent and turned out to have invented/duplicated
values):
- `OrderDisplayFinancialStatus`: `AUTHORIZED, EXPIRED, PAID,
  PARTIALLY_PAID, PARTIALLY_REFUNDED, PENDING, REFUNDED, VOIDED`.
- `OrderDisplayFulfillmentStatus`: `FULFILLED, IN_PROGRESS, ON_HOLD, OPEN,
  PARTIALLY_FULFILLED, PENDING_FULFILLMENT, REQUEST_DECLINED, RESTOCKED,
  SCHEDULED, UNFULFILLED`.

`mapper.ts:mapOrderStatus()` combines these plus a separate cancellation
signal (`cancelledAt`) via an ordered priority chain (cancellation/void →
refunded → restocked → fulfilled → shipping-in-progress → expired →
paid-not-shipped → pending-not-shipped) into the same internal
`OrderStatus` enum WooCommerce orders use. Every branch matches a verified
enum value; an unrecognized or unhandled combination is **skipped and
reported by name**, never guessed — covered by a dedicated test asserting
`financial=null/fulfillment=null` is skipped rather than defaulted to
`NOUVELLE`.

### Payment method
Only Shopify's few well-known built-in gateway ids (`cash_on_delivery`,
`bank_deposit`, `shopify_payments`) are mapped explicitly; any
merchant-specific/third-party gateway id maps to `AUTRE` — deliberately
more conservative than even WooCommerce's four-gateway mapping, since
Shopify gateway ids are less standardized across merchants.

### Customers, refunds, idempotency, race protection
Identical reasoning to WooCommerce (`docs/adr/0010`): customers are
derived from order data (registered customer → matched by
`(source=SHOPIFY, externalId=<customer gid>)`; guest → matched by
`(source=SHOPIFY, email)`), never fuzzy name matching. A refunded order
gets one `Refund` row (`source=SHOPIFY`, `status=COMPLETE`, amount read
directly from `totalRefundedSet`), kept in sync by amount on re-import
rather than duplicated; `paymentStatus` only forced to `REMBOURSE` when
Shopify's own financial status is `REFUNDED`. Order import never
re-runs the internal reservation ledger (the WooCommerce ADR's reasoning
applies unchanged) and never rewrites line items on a re-import.

The `Order(source, externalId)` unique index added in Phase 20 (originally
for WooCommerce) is provider-agnostic and automatically protects Shopify
orders too — `importOrder`'s P2002-catch-and-fall-through-to-update
backstop was ported unchanged. Verified with a genuine
`Promise.all([...])` concurrency test importing the same new Shopify order
twice simultaneously.

## A second genuine race found during this phase's self-review
A dedicated **concurrent duplicate webhook delivery** test (same delivery
id, two simultaneous requests — required by this phase's test matrix)
caught a real bug: both requests can pass the `WebhookEvent` "already
seen?" `findUnique` check before either commits, then both attempt
`prisma.webhookEvent.create()` — the loser hits the
`(integrationId, deliveryId)` unique constraint, and the route's own
catch-block fallback `create` call **also** hit the same constraint,
uncaught, crashing the request instead of returning a graceful response.
Fixed with `shared/webhook-event.ts:recordWebhookEventOnce()`, which
treats that specific P2002 as "a concurrent request already recorded this
delivery" rather than a failure. **This bug existed identically in the
WooCommerce webhook route** (same unguarded `create` pattern) and was
fixed there too, with the same concurrent-delivery test added to
WooCommerce's own webhook test file to verify it — a real, cross-provider
correctness fix that came out of building the second integration, not
scope creep.

## RBAC and audit
No new permission — `integrations.view`/`integrations.manage` cover
Shopify exactly as they cover WooCommerce. New audit metadata is
provider-tagged (`{provider: "SHOPIFY", ...}`) reusing the exact same
`AuditAction` literals Phase 20 added
(`integration.connection_test_succeeded/failed`,
`integration.sync_started/completed/partial_failure`,
`integration.webhook_received/rejected`) — no new action strings needed.
Never audited: access token, client secret, `Authorization`/
`X-Shopify-Access-Token` header values, raw webhook bodies.

## Deferred (explicitly, not silently) / decisions that may need owner input
- **Product taxonomy/Collections mapping.** Flagged above as an open
  decision, not resolved by guessing — what "category" should mean for a
  Shopify-sourced product (the standardized taxonomy leaf? A specific
  Collection? Neither?) is a product decision, not an engineering one.
- **`products/update` and inventory-level webhooks.** Only order-related
  topics are real-time in this phase, matching WooCommerce's own
  precedent (orders are the highest-value real-time case; catalog/stock
  changes are picked up on the next manual "Synchroniser les produits"/
  stock actions).
- **Programmatic webhook registration** via the `webhookSubscriptionCreate`
  mutation — registration remains manual, for the same reasoning as
  WooCommerce.
- **True real-time cross-channel stock locking.** Same limitation as
  WooCommerce: between two sync runs, the same product can be oversold
  across this system's own manually-created orders and Shopify's live
  storefront.
- **More than 10 locations per variant's inventory query, or more than 200
  paginated result pages per sync run** — safety ceilings, not business
  limits, matching the WooCommerce adapter's own bounds.
- **Multiple Shopify stores per instance.** `Integration.provider` is
  `@unique`, matching the one-Instance-per-client model
  (`docs/adr/0002`) — same constraint WooCommerce operates under.
- **OAuth-based public-app installation flow.** This integration assumes
  a merchant-managed custom app token, not a distributed public app —
  consistent with WooCommerce's own consumer-key model and this system's
  single-store deployment shape.

## Live verification
**Not executed — no live Shopify credentials were available in this
environment.** Every authentication, pagination, rate-limit, inventory
model, order-status enum, and webhook-signing fact cited above was
verified against Shopify's official developer documentation (and, for the
webhook payload shape and the two order-status enums specifically,
double-checked a second time after an initial fetch looked
internally inconsistent) rather than assumed from training data — but
nothing here should be represented as production-verified against a real
store. See the Phase 21 completion report for the exact fixture-tested vs.
live-tested breakdown.
