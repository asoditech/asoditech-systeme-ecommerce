# ADR 0030 — Stock reserved at confirmation, per-order recipient name, reopen

## Status
Accepted (2026-09-09). Amends ADR 0002 (order state machine) and the
reservation timing set in the early inventory work.

## Context
Three problems surfaced together from real use:

1. **Stock reserved too early.** A manually-created order reserved stock
   the moment it was created (`NOUVELLE`). For COD, most `NOUVELLE`
   orders are unconfirmed and a large share are never confirmed
   (no answer, fake number). Dozens of them tied up inventory that was
   still sellable. The owner asked for: *"stock does not decrease until
   the order is confirmed."*
2. **Wrong name on the order.** A shop that places every WooCommerce
   order under one account (the store admin login) had every order show
   that account's name. The orders list and confirmation queue read
   `customer.fullName`, but two orders under one account carry different
   billing names.
3. **No undo for a mis-cancel.** A confirmateur who taps "Annuler" on the
   wrong row in the queue had no way back — `ANNULEE` was terminal.

## Decision

### 1. Reservation is taken at CONFIRMEE, released symmetrically
- `RESERVED_ORDER_STATUSES = [CONFIRMEE, EN_PREPARATION]` +
  `orderHoldsReservation(status)` in `src/lib/validation/order.ts` — the
  single source of truth.
- `createOrderAction` no longer calls `reserveStockForOrder`. A
  `NOUVELLE` order — confirmed or not — holds **nothing**.
- Reservation is taken on the `NOUVELLE → CONFIRMEE` transition:
  `updateOrderStatusAction` and `recordConfirmationAttemptAction` both
  call `reserveStockForOrder`. Reserving never fails (backorders are
  allowed — `applyStockMovement` only throws when *on-hand* would go
  negative, which reservation doesn't touch).
- Release is guarded: `→ ANNULEE` releases only when
  `orderHoldsReservation(previous status)` (or returns stock when the
  order was already shipped). `NOUVELLE → ANNULEE` moves no stock — there
  was nothing to release. Same guard in `cancelOrderAction`.
- Only WooCommerce/Shopify **manual** orders were ever in this ledger —
  imported orders reconcile stock from the store's own numbers
  (`sync/stock.ts`), untouched by this change.
- `EXPEDIEE` still converts the reservation to an on-hand deduction;
  `RETOUR` still restocks. Low-stock notification now also fires on
  `CONFIRMEE` (it now reduces what's sellable), and the auto stock-push
  to a linked store runs on `CONFIRMEE` too.

### 2. `Order.shippingName` — recipient snapshot
New nullable column, backfilled to the linked customer's name for
existing rows. Populated from the order's own billing/shipping name:
WooCommerce `mapOrderFields` (shipping name, else billing), Shopify
`mappedOrderFields` (address name, else customer), `createOrderAction`
(customer name at creation — the manual form has no separate recipient
field). Re-import refreshes it. `displayOrderRecipient(order)` in
`format.ts` — `shippingName` else `customer.fullName` else "Client" — is
used by the orders list, order detail (with a "Compte client: …" sub-line
when they differ) and the confirmation queue.

### 3. `reopenOrderAction` — undo a wrong cancellation
`ANNULEE → NOUVELLE` added to the transition table, reachable only via
this action and only when `shippedAt === null` (a shipped-then-cancelled
order is a return, not a mistake). No stock action — with change #1, a
`NOUVELLE` order holds no reservation, so reopening is a pure status
flip. Held by `orders.edit` **or** `orders.confirm` so a confirmateur can
fix their own mis-tap. Button on the order detail page; pushes the status
back to a linked WooCommerce store.

### 4. Confirmation queue ordering
Newest first within the never-called group, then previously-tried orders
least-recently-retried first:
`orderBy: [{ lastConfirmationAttemptAt: asc nulls first }, { placedAt: desc }]`.

## Consequences
- An unconfirmed order never ties up stock. "Disponible" only drops when a
  human confirms the order — which is the point of the confirmation step.
- The reservation ledger's invariant is now "reserved ⟺ status ∈
  {CONFIRMEE, EN_PREPARATION} and not yet shipped" — simpler than the old
  "reserved from creation" which had to special-case NOUVELLE→ANNULEE.
- Migration `20260909170000_order_recipient_snapshot`. Tests updated:
  `tests/actions/orders.test.ts` (reservation now at CONFIRMEE, reopen),
  `tests/actions/order-confirmation.test.ts`,
  `tests/actions/woocommerce.test.ts` (per-order billing name).

## Addendum — reservation ledger reopened to WooCommerce/Shopify orders (2026-09-13)
`c606dc0` (2026-09-12) gated the ENTIRE reservation ledger —
`reserveStockForOrder` / `fulfillStockForOrder` / `releaseStockForOrder` /
`returnStockForOrder` — behind `order.source === "INTERNE"`, to fix a real
double-deduction incident: a WooCommerce/Shopify order's `quantityOnHand`
is also touched by the separate provider stock pull-sync
(`sync/stock.ts`), and running the internal ledger's on-hand-touching
steps (`fulfillStockForOrder` at EXPEDIEE, `returnStockForOrder` at
RETOUR/post-ship-ANNULEE) a second time on the same units produced a false
"Stock insuffisant" at shipment.

That fix over-corrected: it also blocked `reserveStockForOrder` /
`releaseStockForOrder` at CONFIRMEE/ANNULEE — the two operations that
**only ever touch `quantityReserved`, never `quantityOnHand`** (see
`reserveStockForOrder`'s and `releaseStockForOrder`'s own one-line doc
comments in `src/lib/inventory.ts`). Gating those too meant a
WooCommerce/Shopify order confirmed inside ASODITECH showed
`quantityReserved` frozen at 0 — "Disponible" never reflected ASODITECH's
own confirmation state for an imported order, only its provider's.

Fixed by splitting the gate instead of an all-or-nothing one:
- **Reservation is universal again** (any source): `CONFIRMEE` reserves,
  `→ ANNULEE` release clears it. Safe by construction — neither touches
  `quantityOnHand`, so there is nothing to double-count.
- **Physical mutation stays INTERNE-only**: `EXPEDIEE`'s
  `fulfillStockForOrder` and `RETOUR`'s `returnStockForOrder` are
  unchanged — still gated, still the exact fix `c606dc0` shipped.
- **New middle case — EXPEDIEE for a provider order**: since it now holds
  a real reservation (taken at CONFIRMEE) that must eventually clear, but
  must never touch on-hand, `EXPEDIEE` calls `releaseStockForOrder`
  (reservation-only) instead of `fulfillStockForOrder` for a
  WooCommerce/Shopify order. The provider's own on-hand reduction is still
  reconciled exclusively via `sync/stock.ts`, untouched by this.

Also: `Integration.config.forceNouvelleOnImport` (added in the same
`c606dc0` batch) flips from opt-in (default off) to **on by default** —
only an explicit `false` opts out. This is what actually makes "a new
WooCommerce/Shopify order never auto-lands as CONFIRMEE" the default
behavior rather than something a tenant has to remember to enable; see
`ImportOrderOptions`'s doc comment in each provider's `sync/orders.ts`.

New notification: `STOCK_INSUFFISANT_COMMANDE` — when a new order's line
quantity exceeds `availableStockTotal` (Physical − Reserved) for that
product/variation, `checkAndNotifyInsufficientStockForOrder`
(`src/lib/notifications.ts`) fires a read-only alert (never mutates
stock), deduped per `(order, product|variation)` via the existing
`dedupeKey` mechanism — a webhook retry, re-sync, or manual refresh for
the same order is a silent no-op. Called once per new order:
`createOrderAction` (INTERNE) and both providers' `createImportedOrder`
(mirroring `notifyNewOrder`'s own recency guard so a first-time
historical sync doesn't flood hundreds of alerts). Migration
`20260913010000_stock_insufficient_notification`.

Tests: `tests/actions/orders.test.ts`'s "never touch the internal stock
ledger" describe block rewritten for the new split-gate behavior;
`tests/actions/order-confirmation.test.ts` updated; new coverage for the
insufficient-stock alert + dedup and for default-on force-Nouvelle.

## Addendum — a later webhook/re-sync could still auto-confirm a NOUVELLE order (2026-09-13, same day)

Production incident: orders #15606/#15607 showed CONFIRMEE despite the
addendum above already being live. Root cause was a second, distinct gap
in the exact same feature, in `updateExistingOrder` (both providers'
`sync/orders.ts`) rather than in `importOrder`'s creation branch:

- `order.created` fires while WooCommerce still reports `pending` — maps
  straight to NOUVELLE, no forcing needed, order is created correctly.
- WooCommerce later moves the order to `processing` (payment clears) and
  fires `order.updated`. `importOrder` routes an existing order straight
  to `updateExistingOrder`, which applied whatever real status
  `mapOrderStatus` returned as long as `canTransitionOrderStatus` allowed
  it — and `NOUVELLE → CONFIRMEE` is a normal, valid transition. Since
  `forceNouvelleOnFirstImport` was (by design, per the ADR's own original
  text) "scoped to first-time creation only," it had no say here at all —
  the order silently became CONFIRMEE on the SECOND webhook event, having
  correctly avoided it on the first.
- Confirmed by code trace, not by reading production data directly (no
  production DB/credentials were used) — verified by reproducing the
  identical two-webhook sequence (`order.created` "pending" then
  `order.updated` "processing") against the deployed code in tests.

Fixed by extending the exact same guard to `updateExistingOrder`: the
specific `NOUVELLE → CONFIRMEE` transition is now blocked there too,
unless `forceNouvelleOnImport` is explicitly `false`. Every other
transition (→ LIVREE, → ANNULEE, → REMBOURSEE, → ECHEC, CONFIRMEE moving
on to EN_PREPARATION/EXPEDIEE/etc.) is completely unaffected — this is
not a "freeze the order" change, only "don't let a store status alone
promote an unconfirmed order to confirmed." `ImportOrderOptions` is now
threaded through both of `importOrder`'s calls into `updateExistingOrder`
in each provider's `sync/orders.ts`.

One invariant now holds everywhere a WooCommerce/Shopify order's status
is written: **a store's own status can create NOUVELLE, ANNULEE,
REMBOURSEE, LIVREE, or ECHEC freely, and can move a CONFIRMEE order
forward, but it can never by itself turn a NOUVELLE order into CONFIRMEE
— only a human action inside ASODITECH does that** (`updateOrderStatusAction`,
`recordConfirmationAttemptAction`).

Tests: new coverage in both providers' webhook suites (a second delivery
reporting the higher status doesn't promote the order) and both
providers' action-test suites (the identical scenario through
`importOrder` directly, matching what the bulk sync loop calls) — first
import, later re-sync, and the explicit opt-out on both.

## Addendum — WooCommerce's own order-driven stock decrement corrupted `quantityOnHand` (2026-09-13, third fix)

Production report: a brand-new, unconfirmed WooCommerce order for qty 6
(stock 20) made the ASODITECH stock page show 14 — with zero reservation
movement, zero order-lifecycle action taken. Traced to a completely
different mechanism than the two fixes above: the **product** stock pull
sync, not the order import.

**Root cause.** WooCommerce, independent of ASODITECH, decrements a
"Manage stock" product's own `stock_quantity` the instant an order is
placed on the store — before ASODITECH has even seen the order, let alone
confirmed it. That decrement is a product mutation, so WooCommerce fires
`product.updated`. ASODITECH's webhook handler (`importProduct` →
`syncOneProduct`) unconditionally called `reconcileStockFromWooCommerce`
for every product webhook, which writes the external `stock_quantity`
straight into `quantityOnHand` (an `AJUSTEMENT_NEGATIF` movement,
20 → 14). Same physical inventory, represented by two systems with two
different "reservation" timings (WooCommerce reserves at placement;
ASODITECH reserves at CONFIRMEE) — the pull sync had no way to tell "a
genuine manual stock correction on WooCommerce's side" apart from "WooCommerce's
own order-placement decrement," and blindly trusted both.

**Fix — smallest safe change, no new inventory system.** `syncOneProduct`/
`syncVariationsForProduct`/`syncOneVariation`
(`src/lib/integrations/woocommerce/sync/products.ts`) take a new
`reconcileStock: boolean` parameter:
- `syncProducts` (the bulk "Synchroniser les produits" action, deliberately
  triggered by a human) passes `true` — stock reconciliation there is
  unchanged and still runs every pass, exactly as intended for onboarding
  and deliberate resync.
- `importProduct` (the `product.created`/`product.updated` webhook path)
  passes `false` — name/price/status/category still sync in real time;
  only the stock-quantity pull is skipped.

No schema change, no new field, no new table — `quantityOnHand`,
`quantityReserved`, `availableStock()`, `InventoryMovement`,
`applyStockMovement`, `reserveStockForOrder`, `releaseStockForOrder` are
all untouched. The order lifecycle (NOUVELLE holds nothing, CONFIRMEE
reserves, ANNULEE releases) is unchanged — this fix is entirely on the
product/stock **pull** side, orthogonal to the order/reservation ledger.

**Accepted trade-off.** A brand-new product added on WooCommerce no
longer gets its stock row seeded by the real-time webhook alone — it
lands with no `InventoryItem` until the next "Synchroniser les produits"
run. This matches the feature's own original framing ("a safety net for a
missed or never-configured webhook, not a replacement for" the bulk
sync) and is far preferable to the alternative (silent corruption on
every order).

**Shopify.** `src/lib/integrations/shopify/sync/products.ts`'s
`importProduct` (webhook path) has the same unconditional
`reconcileVariantStock` → `reconcileStockFromProvider` call shape,
strongly suggesting the identical root cause — but this was not
independently reproduced/proven for Shopify, and per explicit scope was
left untouched. Flagged as a follow-up.

**UI/docs**: `/integrations` → WooCommerce card's "Générer un secret
webhook" dialog and the "Synchroniser les produits" button both corrected
to state plainly that webhooks never touch stock and that the manual sync
button is the sole intentional stock-reconciliation action
(`src/components/integrations/woocommerce-actions.tsx`). In-app
Documentation Center: new troubleshooting entry in
`src/lib/docs/content/stock.ts` ("le stock physique a diminué sans
commande confirmée") and a callout in
`src/lib/docs/content/integrations.ts`'s "Synchronisation des produits"
article.

**Existing production data**: not touched by this fix, and not repaired
by it — an `InventoryItem` row already corrupted by a past auto-webhook
reconciliation stays at whatever value it was left at; this fix only
stops the ongoing cause. No data was rewritten, inspected write-side, or
guessed at as part of this change (see the session's own investigation
notes — no production credentials were used).

Tests: `tests/webhooks/woocommerce.test.ts`'s product-webhook suite
rewritten for the new default (no stock touched; product fields still
sync); new "root-cause regression" describe block reproducing the exact
production sequence end-to-end (NEW order → the order-driven
`product.updated` webhook → CONFIRM → CANCEL, asserting on-hand/reserved
at every step) plus an idempotency test (repeated `product.updated`
deliveries never drift); `tests/actions/woocommerce.test.ts`'s bulk-sync
stock-reconciliation coverage re-verified unchanged (still green,
untouched behavior).
