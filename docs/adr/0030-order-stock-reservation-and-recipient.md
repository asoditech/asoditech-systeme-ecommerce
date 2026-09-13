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
