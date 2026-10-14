# Roadmap progress — 2026-10-13 (local, uncommitted work on top of `c0ce5a4`)

Status of every roadmap item that has an actual source. Local tests prove the
code paths against fakes and the local test database only: **no real store,
production or Preview validation is implied by "covered by local tests".**

Sources. None of the lists below is stored in the repository; they are owner
requests recorded in the working sessions:

- **List 1 — 16 items** (A1–A5, B1–B3, C1–C3, D1–D3, E1–E2): « Final Focused
  Audit and Consolidated Fixes », 2026-10-11.
- **List 2 — 10 sections** (customer identity rule): 2026-10-05 — it predates
  List 1. Its "simplified plan" (no CustomerChannel table, no merge feature)
  is what was built (commit `14d4f45`, live since `1ca271a`).
- **List 3 — 10 requirements** (phased plan 2026-10-12, Phases 1–6 so far).

Legend: **Done+tests** implemented and covered by local tests · **Done,
validation open** implemented, real-world validation still missing ·
**Partial** · **Not implemented** · **Blocked** by a business decision or an
external service · **Superseded**.

Updated 2026-10-13 (second pass): the « Remaining / acceptance » column says
what is left and how it is accepted; **Safe now?** = can be finished locally
without a new business decision or schema change; **External?** = final
verification needs a real store, a provider or production data.

Browser results for List 1: `docs/RELEASE-VERIFICATION-CHECKLIST.md` §7
(2026-10-12: 6 PASS, 4 PASS with caveat, 5 BLOCKED).

## List 1 — 16 items

| # | Item | Status | Evidence | Remaining / acceptance | Safe now? | External? |
|---|---|---|---|---|---|---|
| A1 | Customer combobox, keyboard navigation | Done+tests | `src/components/ui/use-listbox-navigation.ts`, `tests/lib/listbox-navigation.test.ts` | — | — | No |
| A2 | Preparation warehouse first | Done+tests (browser PASS 2026-10-12, checklist §7; dedicated source test 2026-10-14) | checklist §7 A2, `tests/lib/order-form-warehouse-first.test.ts` | — | — | No |
| A3 | Traceability purchase cost / « non enregistré » | Done+tests | `src/actions/traceability.ts`, `tests/actions/traceability-cost.test.ts` | — | — | No |
| A4 | Unique tracking numbers | Done+tests (app-level check, no DB unique index) | `tests/actions/tracking-number-unique.test.ts` | Measure existing duplicates before any DB index | No (production data) | Yes |
| A5 | Shared date-range picker | Done+tests | `src/components/date-range-fields.tsx`, `src/lib/date-range-query.ts`, `tests/lib/date-range-query.test.ts` | — | — | No |
| B1 | Report channel filters | Done+tests | `src/lib/reports/online-channel.ts`, `tests/actions/report-filter-isolation.test.ts` | — | — | No |
| B2 | Opt-in store payment sync | Done, validation open (migration `20261012120000` not deployed) | `src/lib/orders/store-payment.ts`, `tests/lib/store-payment.test.ts` | Real development-store run (checklist §3) | — | Yes |
| B3 | Missing purchase-cost warnings | Done+tests | `src/lib/catalog/missing-cost*.ts`, `tests/lib/missing-cost*.test.ts` | — | — | No |
| C1 | Returned shipment → order RETOUR | Done+tests | `tests/actions/shipment-order-sync.test.ts`, ADR 0006 addendum | Decision: backfill older orders or not | No (decision) | Yes (prod data) |
| C2 | Returns bulk reception | Done+tests | `src/lib/returns/bulk-selection.ts`, `tests/lib/returns-bulk-selection.test.ts` | — | — | No |
| C3 | Exchanges (« Échange ») | Blocked | `docs/research/order-exchanges-proposal.md` | 5 owner decisions (shipping payer, price difference, KPIs, commission, carrier automation) + an `OrderExchange` table (schema approval). Workaround today: physical return + new order | No | Carriers |
| D1 | Several stores per company | Blocked (design not final) | `docs/decisions/multi-store-integrations.md` | Open questions in that note; schema change | No | Yes |
| D2 | Sync lease / cursor / history toggle | Done, validation open | `src/lib/integrations/shared/sync-loop.ts`, `tests/actions/integration-sync-hardening.test.ts` | Real development-store run | — | Yes |
| D3 | Remote product delete / restore | WooCommerce: Done+tests, validation open. Shopify: Not implemented | `src/lib/integrations/woocommerce/remote-deletion.ts`, `tests/integration/woocommerce-remote-deletion.test.ts` | Shopify: separate phase (no « restored » webhook; gid lookup) | No (scope decision) | Yes |
| E1 | WhatsApp per-type mutes, failure alerts | Done, validation open | `src/lib/whatsapp/alert-types.ts`, `src/lib/whatsapp/dispatch.ts` (`oncePerDay`), `tests/lib/whatsapp-alert-preferences.test.ts` | Live test number (checklist §5). ADR 0058 follow-ups (delivery log table, retries, daily cron) need schema + `vercel.json` cron | No | Yes (Meta) |
| E2 | Favourite pages | Done+tests (2026-10-13: long labels no longer run under the « Favoris » controls) | `src/actions/favorites.ts`, `src/components/layout/sidebar-nav.tsx`, `tests/lib/sidebar-variant.test.ts` | — | — | No |

## List 2 — 10 sections (customer identity)

| § | Section | Status | Evidence | Remaining / acceptance | Safe now? | External? |
|---|---|---|---|---|---|---|
| 1 | Audit of create/match flows | Done (all flows use one helper) | `src/lib/customers/find-or-create.ts` | — | — | No |
| 2 | Name + phone normalisation | Done+tests | `src/lib/customers/identity.ts`, `tests/lib/customer-identity.test.ts` | — | — | No |
| 3 | Matching policy | Done+tests (advisory lock, concurrency within one company AND simultaneous across two companies, oldest historical duplicate reused, same name + phone in another company never reused — the last three tested since 2026-10-13) | `find-or-create.ts`, `tests/actions/customer-identity.test.ts` | — | — | No |
| 4 | Duplicate-data audit on production | Blocked (not run). Read-only tool ready: `scripts/audit-customer-duplicates.ts` (READ ONLY transaction, refuses unless `--target-host` names the DB host, prints counts only) + `src/lib/customers/duplicate-audit.ts`, `tests/lib/customer-duplicate-audit.test.ts`; run on local dev only (11 customers, 0 groups) | — | A separately authorised run against production; then decide what to do with groups (no automatic merge) | No | Yes (production) |
| 5 | Customer–channel/store model | Superseded (visibility from orders/sales) | `prisma/schema.prisma` | — | — | No |
| 6 | Visibility rules | Done+tests | `src/lib/customers/visibility.ts` | — | — | No |
| 7 | Affected features | Done | `src/actions/search.ts`, `src/lib/queries/customers.ts` | — | — | No |
| 8 | Migration strategy | Done (`phoneKey` + backfill) | `prisma/migrations/20261006120000_customer_phone_key` | — | — | No |
| 9 | Testing strategy | Done+tests | `tests/actions/customer-identity.test.ts` | — | — | No |
| 10 | Recommendation | Superseded by the simplified plan; review/merge workflow deliberately not built | — | Only if the §4 audit shows duplicates worth merging (decision) | No | Yes |

## List 3 — 10 requirements (2026-10-12 plan)

| # | Requirement | Status | Evidence | Remaining / acceptance | Safe now? | External? |
|---|---|---|---|---|---|---|
| 1 | WooCommerce product publication failure | Done+tests | `src/lib/integrations/woocommerce/errors.ts`, `tests/actions/product-publishing.test.ts` | A real rejection seen once on a development store | — | Yes |
| 2 | Automatic inventory management for imported products | WooCommerce and Shopify: Done+tests, validation open (per-connection « Qui gère le stock ? », user-owned « Suivre le stock », onboarding rows only from reported quantities) | `woocommerce/sync/{products,stock-push}.ts`, `shopify/sync/{products,stock-push}.ts`, `tests/integration/{woocommerce-inventory-*,shopify-inventory-safety}.test.ts` | Real development stores | — | Yes |
| 3 | Per-company feature controls in `/platform` (order sync, logo) | Not implemented — proposal only | `docs/decisions/platform-order-sync-and-branding.md` | Schema approval (3 `Tenant` columns) + 3 decisions in that note | No | No |
| 4 | Hide subscription prices | Done+tests | `tests/lib/plan-price-visibility.test.ts` | — | — | No |
| 5 | Export availability after remote deletion | WooCommerce: Done+tests, validation open (unlink removes the publication → exportable again). Shopify: Not implemented | `remote-deletion.ts`, `tests/integration/woocommerce-remote-deletion.test.ts` | Real development store; Shopify later phase | — | Yes |
| 6 | Shared inventory across online and offline locations | Investigated; current behaviour = one central stock (ADR 0036), online WooCommerce stock = active ENTREPOT rows only (ADR 0020 §10), Shopify = per mapped location, offline sales move the same rows. Allocation per store not built | `docs/decisions/multi-store-integrations.md`, `sync/stock-push.ts` | Owner decisions: shared vs allocated per store, which warehouses feed each store | No | No |
| 7 | Sidebar redesign as a reversible experiment | Partial — opt-in « sections » variant (cookie), classic stays default; long « Favoris » labels fixed 2026-10-13 | `src/components/layout/sidebar-nav.tsx`, `tests/lib/sidebar-variant.test.ts` | Owner decision: make « sections » the default or drop it | No (decision) | No |
| 8 | Bottom action bar overlaps form fields | Done+tests | `tests/lib/form-actions-layout.test.ts` | — | — | No |
| 9 | Missing purchase-cost warning across pages | Done+tests | `src/lib/catalog/missing-cost-routes.ts`, `tests/lib/missing-cost-banner-routes.test.ts` | — | — | No |
| 10 | Product selection in Traçabilité | Done+tests | `src/components/traceability/trace-unit-picker.tsx`, `tests/actions/trace-unit-picker.test.ts` | — | — | No |

Numbering is the 2026-10-12 request's own (the earlier version of this table
used the implementation-phase order).

## WooCommerce inventory — Phase 6 closure (2026-10-13)

- Damaged units are a separate bucket, never part of on-hand (`applyStockMovement`
  ENDOMMAGE: on-hand −n / damaged +n; damaged returns: damaged +n only), so the
  pushed number (on hand − reserved, active warehouses) already excludes them.
- One push plan for bulk and automatic push (`planWooCommerceStockPush`), store-managed
  stock → nothing pushed; variation = its own rows only; missing row ≠ 0.
- Concurrent `product.deleted`/`product.restored` deliveries: flag/clear serialised
  by a row lock (one audit event per transition).
- Decided 2026-10-13: when ASODITECH tracks a product the store does not, the
  first VALID push (ownership, link, tracking, own rows all verified) sends
  `manage_stock: true` + the verified number; any refusal sends no request.
- Re-saving a connection (`connectIntegrationAction`, same `Integration`
  row) — since 2026-10-13: for the SAME store address (validated `siteUrl` /
  `shopDomain`) the company's audited choices are kept (`remoteDeletionMode`,
  `inventoryOwner`, `importHistoricalOrders` + `historyCutoffAt`,
  `forceNouvelleOnImport`; Shopify: the same without `remoteDeletionMode`),
  each only if VALID (an invalid value falls back to its default); sync
  cursors restart. Before, every re-save (even a key rotation) reset them —
  which silently turned a store-managed stock back to ASODITECH-managed and
  resumed pushes. **Owner decision (2026-10-13): a DIFFERENT store address
  never inherits** — it starts from the safe defaults (manual unlinking,
  ASODITECH stock, history imported, first import NOUVELLE). The audit event
  `integration.connected` records `storeAddress` (`new` / `same` /
  `changed`), `keptSettings` and `initializedSettings`. Local evidence:
  `tests/integration/integration-reconnect-settings.test.ts` (10 tests, fakes
  only: rotation, disconnect + reconnect, address typed differently, other
  store and back, invalid values, other company, no permission, Shopify off).

## Maintenance scripts (2026-10-13)

- `scripts/backfill-tenant-baseline.ts` and `scripts/cleanup-variation-products.ts`
  did not start under `tsx`: their imports (`@/lib/prisma`, `@/lib/tenant/*`)
  begin with `import "server-only"`, which pnpm only installs inside Next
  (`next/dist/compiled/server-only`) and which, outside the `react-server`
  condition, is meant to throw. Fix: `scripts/server-only-cli.ts`, imported
  first, maps that one marker to Next's own server entry (`empty.js`) for the
  script process only. Their logic and safety flags (`--dry-run`) are unchanged.
- Verified without running either script or reaching a database:
  `tests/lib/maintenance-script-startup.test.ts` loads exactly each script's
  imports in a child `tsx` process (DATABASE_URL = a closed local port, no
  other variables) — loads with the shim, fails with « Cannot find module
  'server-only' » without it. Running the scripts against a real database is
  still the owner's separate step.
- `scripts/audit-customer-duplicates.ts` uses a plain `PrismaClient` instead
  (no app modules), so it never had the problem.

## Shopify

Enabled for **local development only** via `.env.development.local`
(`SHOPIFY_INTEGRATION_ENABLED=true`, git-ignored, read only by `next dev`).
Built and covered by local tests against a fake server: connect/configure,
connection test, locations/products/orders import, stock push, webhooks,
publishing (`tests/actions/shopify.test.ts`), and since 2026-10-13 the stock
safety contract (`tests/integration/shopify-inventory-safety.test.ts`):
per-connection « Qui gère le stock ? », the user's « Suivre le stock »
kept, one plan for bulk and automatic push (own row, own location, never a
0), automatic push off while the kill switch is off; and (later on
2026-10-13) both pushes refuse rows at a location Shopify itself reports
`isActive: false` (never redirected; a location missing from the list is not
assumed inactive; list unreadable → nothing sent) and re-send a batch Shopify
rejects row by row (absolute quantities, so a re-send cannot double-count;
network/auth/throttling errors are not retried). Whether Shopify applies part
of a rejected batch is not documented in the adapter and is not verified on a
real store. **Not built:** remote
deletion/unlinking, order-status push to Shopify, and switching Shopify's own
« Suivre la quantité » on (needs `inventoryItemUpdate`/activation, to be
verified on a development store first). No real Shopify store has been tested.
Deletion/unlinking and order-status push stay out until their rules are set:
what proves a permanent deletion on Shopify (the adapter's `getProduct`
returns `null` when Shopify answers no product — whether that alone is a
reliable deletion signal, like WooCommerce's specific 404 code, is not
verified on a real store), whether Shopify gets
its own « Que faire lorsqu'un produit est supprimé ? », and which ASODITECH
statuses map to which fulfilment / cancellation calls.

## Audit 2026-10-13 (third pass) — candidates checked, nothing invented

- WhatsApp: no gap found — 53 local tests already cover recipients,
  tenant isolation, dedupe, the daily delivery-failure cap (released when
  Meta refuses), disabled tenant / missing sender, and non-fatal errors.
- Sidebar: favourites controls labelled (`aria-label`), pin state exposed
  (`aria-pressed`), long labels fixed and tested in the previous pass.
- Customer identity: two untested rules found and covered (see List 2 §3).

## Completion sprint (2026-10-13, local only)

Three read-only audits (order sync, tenant purge, webhooks) were checked
against the code before any change. Fixed only where the code broke an
already-documented rule; each fix has a regression test that was run FAILING
without the fix (except A4, see below). All evidence is local (fakes + local
test database) — no real-store verification.

**Fixed**

- **Webhook: unreachable store URL crashed unrecorded.** Three WooCommerce
  webhook paths (product.updated, variation → parent, product.restored) called
  `loadWooCommerceClient()` outside any error handling; a store URL that no
  longer validates (DNS failure / now private — `ssrf.ts`) gave an unhandled
  500 with no `WebhookEvent` row and no alert. Now: ECHEC recorded (alerts) and
  500 so WooCommerce retries; the later retry succeeds. `src/app/api/webhooks/woocommerce/route.ts`,
  test « a store URL that no longer validates … » in `tests/webhooks/woocommerce.test.ts`.
- **Order sync A1: a store cancellation released a reservation the order no
  longer held** (order shipped once, then ECHEC → EN_PREPARATION retry): it ate
  another order's reservation. The store path now uses the manual rule
  (`shippedAt` set → nothing to release, `src/actions/orders.ts` `wasFulfilled`,
  ADR 0036). Both providers' `updateExistingOrder`; tests « an order already
  shipped once … » in both webhook test files.
- **Order sync A4: refund find-then-create had no lock.** Each provider's
  update transaction now starts with `SELECT … FOR UPDATE` on the order row
  (same pattern as `order-purge.ts`), and reads `shippedAt` under that lock.
  The race itself did not reproduce locally (10 simultaneous deliveries gave
  one refund with or without the lock); the test pins the outcome only.
- **Tenant purge backstop (G2).** The rule « trial only, no platform admin »
  ran only BEFORE the transaction although its doc said it was also a
  backstop inside it. Now re-checked inside the transaction after locking the
  tenant and subscription rows. `src/lib/tenant/delete.ts`, tests « backstop:
  … » in `tests/lib/tenant-delete.test.ts`.

**Verified, no change needed**: webhook signatures (raw body, constant-time,
tenant pinned by the verifying secret, `runWithTenant`), delivery dedupe and
ECHEC retry; the purge ends with a zero-row check over every tenant-owned
model derived from the schema (`TENANT_MODEL_ACCESSORS`, `delete.ts`), so a
model missing from its delete lists rolls the purge back (the read-only audit
also matched the lists model by model); order creation is idempotent
(`@@unique([tenantId, source, externalId])`); bulk and webhook use the same
status mapping; customer identity in imports uses `findOrCreateCustomer`.

**Order sync — decisions required (implementation blocked until answered)**

1. *A2 — imported orders in a reserving or shipped status.* With
   « Toujours importer en Nouvelle » off, a paid order lands CONFIRMEE without
   a reservation; Shopify can create an order directly EXPEDIEE (ADR 0036:187
   says never auto-applied) or ECHEC. Later steps then release/fulfil a
   reservation that never existed. Decide: reserve at import, land such
   orders as NOUVELLE, or keep as-is with a « no reservation » marker.
2. *A3 — « Synchroniser les commandes » never refreshes held orders* (ADR
   0010/0030 say it should). Ready once (1) is decided — refreshing before
   that would apply A2's unsafe transitions in bulk.
3. *A5 — Shopify PARTIALLY_REFUNDED + UNFULFILLED* is skipped (refund lost,
   webhook recorded TRAITE). Which status should it keep?
4. *A6 — store-driven LIVREE/ANNULEE* do not set `deliveredAt`/`cancelledAt`
   (manual path does) → missing from delivery-time metrics. Set them?
5. *B1* Shopify « FULFILLED » / Woo « completed » → LIVREE (commission
   earned): does « fulfilled » mean delivered? *B2* after a manual re-confirm,
   who wins a later store cancellation? *B3* stale Woo deliveries (no
   `date_modified` check) can reopen ANNULEE → NOUVELLE. *B4* Shopify
   cancelled + refunded → ANNULEE, payment never REMBOURSE (Woo differs).

**Webhooks — open (low)**: ECHEC answered 200 when no API client (no store
retry); no body-size limit before signature checks (work grows with tenant
count); Shopify falls back to the first verifying row when the shop-domain
header is missing (needs a shared secret); 404 vs 401 reveals whether a
provider is connected anywhere; suspended tenants still processed — policy
decisions.

**Tenant purge — open**: G1 a platform admin can flip a paying tenant to
TRIALING then purge (accepted, audit-only per ADR 0053); G3 the
`tenant.deleted` audit is written after commit, best-effort.

**Next batch**: order-sync stock-ledger consistency — decisions 1 and 2 above,
then A2 + A3 together with tests on both providers.

## Order sync consistency sprint (2026-10-13, local only)

Implemented for WooCommerce AND Shopify through one shared module
(`src/lib/integrations/shared/order-sync-rules.ts`); ADR 0030 addendum
(2026-10-13) records the rules. Local evidence only (fakes + local test DB).

| Item | Status | Evidence |
|---|---|---|
| Store CONFIRMEE takes the strict reservation (setting off) or stays NOUVELLE when short; never created directly in a reserving / EXPEDIEE status | Done+tests | `order-sync-consistency.test.ts` « import of an already-confirmed order », « IN_PROGRESS on first import » |
| Release only what the order's ledger holds (no phantom / double release) | Done+tests | « CONFIRMEE WITHOUT a reservation… », « two cancellation deliveries… » |
| Bulk sync refreshes held orders (status, totals, refunds), bounded, refused transitions not retried | Done+tests | « bulk « Synchroniser les commandes » refreshes… » (both providers) |
| Partial refund on a held Shopify order (unmappable status) kept, not REMBOURSE | Done+tests | « PARTIALLY_REFUNDED + UNFULFILLED on a held order… » |
| Delivered / cancelled dates from the store's time, never overwritten | Done+tests | « …cancelledAt from the store's own time… », « …deliveredAt = date_completed_gmt… » |
| Stale reopen / cancellation after a newer manual confirmation refused (ordering by store modification time; unknown → refused) | Done+tests | « …does NOT undo a manual CONFIRMEE… » (webhook suites), « a stale « pending »… » |
| Duplicate refund delivery | Done+tests — deterministic lock test (fails with the lock removed) | « duplicate refund delivery — the order-row lock… » |

Regression proof: each protection (row lock, ledger guard, reservation
routing, ordering, unmapped-status refresh, dates, bulk refresh) was removed
in turn from scratch copies and the suite FAILED; files restored and
hash-checked. Tests that encoded the superseded rule (stale cancel after a
manual re-confirmation always applied) now carry store modification times.

**Decisions still required**

1. *Imported ECHEC* (WooCommerce « failed », Shopify EXPIRED — a PAYMENT
   failure, never shipped): ASODITECH's ECHEC means a failed delivery after
   EXPEDIEE (`RESERVED_ORDER_STATUSES` doc). Staff retrying it (ECHEC →
   EN_PREPARATION → EXPEDIEE) fulfils a reservation that was never taken
   (manual path, `src/actions/orders.ts`). Options: land payment failures as
   ANNULEE; keep ECHEC but forbid the retry when `shippedAt` is null; or
   reserve on that retry. Current behaviour unchanged.
2. *Meaning of Shopify « FULFILLED » / WooCommerce « completed »* → LIVREE
   (commission earned at LIVREE, ADR 0049). LIVREE is only reachable from
   EXPEDIEE, so a store cannot deliver an order ASODITECH has not shipped
   (mismatch alert instead). Shopify FULFILLED means « all items fulfilled
   (shipped) », not necessarily delivered — confirm whether it should earn
   the commission.
3. *Shopify cancelled + refunded* maps to ANNULEE (cancellation first), so
   `paymentStatus` never becomes REMBOURSE although the Refund row exists;
   WooCommerce only marks REMBOURSE on its « refunded » status. Unified rule?
4. *Clock skew* between the store and ASODITECH can misorder events that are
   seconds apart; no tolerance window was invented.

**External verification required**: that real stores send
`date_modified_gmt` / `date_completed_gmt` (WooCommerce) and `updatedAt`
(Shopify) as documented, and how they order webhooks — not verifiable with
fakes.

## Webhook reliability sprint (2026-10-13, local only)

| Item | Status | Evidence |
|---|---|---|
| Signature over the raw body, constant-time, tenant pinned by the verifying secret, `runWithTenant` | Done+tests (verified, unchanged) | `src/lib/integrations/shared/hmac.ts`, both webhook suites |
| Same 401 whether no connection exists anywhere or none verifies (was 404 / 401) | Done+tests | « no … integration anywhere → the same 401 … » (both suites) |
| Shopify: a delivery is accepted only when exactly ONE integration verifies it (no header + shared secret, or one shop connected twice → refused, never the first row) | Done+tests | « shared secret and NO shop-domain header … », « the same shop connected by two companies … » |
| A deliberately skipped order import is recorded « IGNORE », not « TRAITE » | Done+tests | « … recorded « IGNORE », not « TRAITE » » (both suites) |
| Shopify inventory path: a failing failure-record no longer throws; clean 500 | Done+tests | « inventory_levels/update: when recording … fails … » |
| WooCommerce unreachable store URL → ECHEC + 500 (earlier sprint) | Done+tests | « a store URL that no longer validates … » |
| Body-size limit, suspended tenants, 200-on-permanent-ECHEC | Decision required | `docs/decisions/order-sync-open-decisions.md` (webhook section) |
| Real stores' retry/disable behaviour, header presence, platform body limit | External verification | — |

Each fix was reverted in a scratch copy and its tests failed (2, 2, 2, 1),
then restored and hash-checked.

**Order-sync decisions (1–4)**: matrix with current behaviour, risk,
options and recommendation in `docs/decisions/order-sync-open-decisions.md`
— all implementable without a migration; nothing changed until decided.

## Order decisions + webhook policies sprint (2026-10-14, local only)

On `feat/multi-tenant-foundation` @ `363c3c8` (uncommitted). Owner decisions
recorded in `docs/decisions/order-sync-open-decisions.md` (« Decisions taken »)
and ADR 0030 addendum « 2026-10-14 »; shared rules in
`src/lib/integrations/shared/order-sync-rules.ts` + `webhook-body.ts`. No
migration, no schema change.

| Item | Status | Evidence |
|---|---|---|
| §1 Payment failure (Woo `failed`, Shopify `EXPIRED`) → NOUVELLE + payment ECHEC; held orders keep status (EN_ATTENTE → ECHEC only) | Done+tests | `order-sync-consistency.test.ts` « payment-failed order… », « §1 payment failure on an order already held » |
| §1 Legacy never-shipped ECHEC: retry / shipment / carrier auto-ship refused (audited); recovery Annuler + Rétablir | Done+tests | « §1 legacy ECHEC never shipped… » (manual retry, real failed delivery kept, « À expédier » + auto-ship) |
| §2 Shopify FULFILLED = shipped (→ EXPEDIEE, never auto-applied, no LIVREE / commission / deliveredAt); Woo `completed` unchanged | Done+tests | « §2 Shopify FULFILLED… » |
| §3 Cancelled + fully refunded → ANNULEE + REMBOURSE (COMPLETE refunds ≥ total in cents); partial stays partial; duplicates one row | Done+tests | « §3 cancelled and refunded… », `order-sync-rules.test.ts` cents table |
| §4 Clock tolerance 2 min (inclusive), stale / review / applied, unknown → review + alert | Done+tests | « §4 clock tolerance… » (deterministic T, −5 min … +2 min 1 s, missing / invalid), pure boundary table |
| Webhook body limit 1 MiB, 413 before parsing / signatures, bounded stream read | Done+tests | `webhook-policies.test.ts` (exact limit, +1 byte, declared length, chunked stream cancelled) |
| Suspended company → `SUSPENDU` + 200, never processed nor replayed; tenant isolation | Done+tests | `webhook-policies.test.ts` « suspended company » |
| Permanent (ECHEC + 200) vs transient (ECHEC + 500) vs signature (401) vs skipped (IGNORE) vs duplicate | Confirmed, tests added for the 2 untested permanent cases | `webhook-policies.test.ts` « permanent failures… »; existing suites |
| List 1 A2 dedicated test | Done+tests | `order-form-warehouse-first.test.ts` (source checks — no DOM harness) |

Regression proof: each protection (tolerance, full-refund rule, « store
behind » rule, FULFILLED mapping, manual retry guard, shippable + auto-ship
guard, held payment rule, `failed` mapping, suspension check, body limit) was
removed in turn from the source and its tests FAILED; files restored and
SHA-256-checked.

**Remaining decisions / external checks**

- ~~Failed payment later paid / manual refunds of store orders / « Emballage »
  for legacy ECHEC~~ — decided and implemented 2026-10-14 bis (next section).
- External: real stores' `date_modified_gmt` / `updatedAt` presence and clock
  offsets; Shopify FULFILLED timing vs delivery; providers' behaviour on 200 /
  413 (retry, disable); hosting body limit in production.

## Payment / refund safety sprint (2026-10-14 bis, local only)

Same branch and HEAD (`363c3c8`), uncommitted. Owner decisions 5–8 in
`docs/decisions/order-sync-open-decisions.md` « Payment & refund identity »;
ADR 0030 and ADR 0007 addenda. No migration, no schema change.

| Item | Status | Evidence |
|---|---|---|
| Store paid after ECHEC → PAYE (opt-in; newer than the recorded failure; never cancelled / refunded; idempotent; audited) | Done+tests | `tests/integration/payment-refund-safety.test.ts` (both providers: newer, duplicate, replayed failure, opt-in off, stale, ±2 min window incl. boundary, missing time, legacy ECHEC, cancelled, refund carried) |
| Payment change never confirms / reserves / ships | Done+tests | same file: status, `confirmedAt`, ledger, shipments asserted unchanged |
| Store refunds: one cumulative row per provider, cents, duplicate deliveries, Woo refund ids once | Done+tests | same file + `order-sync-rules.test.ts` |
| Manual refund on a store order: INTERNE, audited as manual, not executed on store, cents cap incl. store row | Done+tests | same file « refunds recorded by hand » |
| Store + manual refunds never added together to reach « Remboursé »; « Paiement à vérifier » alert | Done+tests | same file + `refundCoverage` table |
| « Emballage » hidden for legacy never-shipped ECHEC without reservation (server refusal kept) | Done+tests | `hiddenOrderStatusOptions` unit + source checks |

**Blocked (needs schema approval):** per-refund external identifiers (no
column on `refunds`). **Fixed before commit:** approving a refund to
COMPLETE (`updateRefundStatusAction`) now marks REMBOURSE only when
`refundCoverage` = covered (tests through the action: partial, mixed,
independently covered, duplicate approval). **External:**
real stores' paid-after-failed sequence and refund payloads — not verified
against a real store.
