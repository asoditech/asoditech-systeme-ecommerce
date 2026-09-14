# ADR 0036 — Inventory Single Source of Truth & Physical-Return Lifecycle (v1)

## Status
Accepted (2026-09-14). Builds directly on the reservation/fulfillment
foundation ADR 0019 (`src/lib/inventory.ts`'s `applyStockMovement`, Phase
32a) and ADR 0030 (stock reservation moved to CONFIRMEE) already
established — it does not replace that foundation, it closes the
remaining gaps in it: a WooCommerce/Shopify order's `quantityOnHand` was
never actually fulfilled by ASODITECH's own workflow (only ever released
its reservation), a connected store's own stock number could still
overwrite ASODITECH's local stock at several points, and there was no
mechanism at all to credit stock back after a shipped order was cancelled
or returned other than trusting `Order.status` — which conflated a
financial/workflow label with a physical fact.

## Context

### The problem
Before this change, ASODITECH's local inventory was not a genuine single
source of truth:

- **EXPEDIEE only physically fulfilled an INTERNE order.** A WooCommerce/
  Shopify order's `EXPEDIEE` transition released its reservation but never
  ran `fulfillStockForOrder` — the assumption was that the provider's own
  stock reduction, pulled in by a separate sync, already accounted for the
  physical consumption. This meant `quantityOnHand` for a provider order's
  units was only ever as fresh as the last explicit "Synchroniser les
  produits" run — stale between syncs, and never touched at all if the
  merchant stopped clicking that button.
- **The provider's own stock number could silently overwrite local
  stock.** `reconcileStockFromProvider` reconciled an *existing*
  `InventoryItem` row toward whatever WooCommerce/Shopify reported
  (`AJUSTEMENT_POSITIF`/`AJUSTEMENT_NEGATIF`), on every routine
  "Synchroniser les produits" run and on Shopify's real-time
  `inventory_levels/update` webhook. Any of ASODITECH's own order
  fulfillment, physical returns, manual adjustments, or stocktakes could
  be silently overwritten the next time a sync or webhook ran, because the
  provider's number was treated as at least as authoritative as
  ASODITECH's own ledger.
- **No physical-return mechanism existed.** Marking an order `RETOUR`, or
  cancelling a shipped `INTERNE` order, called `returnStockForOrder` and
  restored the *entire* originally-sold quantity to on-hand automatically,
  unconditionally, with no way to represent a partial return, a damaged
  unit, or multiple separate return events. The physical fact ("N units
  came back, M of them sellable") and the workflow/financial label
  (`Order.status`) were the same trigger — a mis-set status silently moved
  real stock.
- **A store's own status could drive local fulfillment.** Shopify's
  `mapOrderStatus` maps `IN_PROGRESS`/`PARTIALLY_FULFILLED` fulfillment
  statuses straight to `EXPEDIEE`; `updateExistingOrder` would apply that
  transition automatically whenever `canTransitionOrderStatus` allowed it
  (reachable from `EN_PREPARATION`), releasing the reservation without
  ever running `fulfillStockForOrder` — a real corruption path once
  EXPEDIEE is expected to be the physical-fulfillment event for every
  source.

### Previous behavior, precisely
- `EXPEDIEE`: INTERNE → `fulfillStockForOrder` (reserved -= qty, onHand -=
  qty). WOOCOMMERCE/SHOPIFY → `releaseStockForOrder` only (reserved -=
  qty; onHand untouched, on the theory the provider's own reduction,
  pulled separately, already accounted for it).
- Post-ship `ANNULEE` / `RETOUR`: INTERNE → `returnStockForOrder` (onHand
  += the full originally-sold quantity, unconditionally). WOOCOMMERCE/
  SHOPIFY → no-op (same theory as above).
- WooCommerce/Shopify product sync and the Shopify `inventory_levels/
  update` webhook: reconciled an existing `InventoryItem` row toward the
  provider's number on every run.
- `pullStockBeforeReservationRelease`: a targeted pre-EXPEDIEE pull that
  refreshed a provider order's `quantityOnHand` from the store immediately
  before releasing its reservation, specifically to paper over the fact
  that EXPEDIEE didn't otherwise reconcile anything for that source.

## Decision

### Inventory invariants
1. **`InventoryItem` (`quantityOnHand` / `quantityReserved` /
   `quantityDamaged`) is ASODITECH's ONLY authority for local physical and
   reserved stock**, for every product regardless of origin. It is never
   a passthrough or a mirror of a connected store's own number once it
   exists.
2. `available` is always derived, never stored:
   `max(0, quantityOnHand - quantityReserved)`.
3. Every quantity mutation goes through the one canonical primitive,
   `applyStockMovement` (ADR 0019/32a) — including the new physical-return
   path (`applyPhysicalReturnLine`, itself built on `applyStockMovement`).
   There is no second ledger.
4. WooCommerce/Shopify stock becomes **one-way downstream only**:
   ASODITECH → store. A connected store's own reported quantity may only
   ever **initialize** an `InventoryItem` row ASODITECH has never seen —
   never overwrite one that already exists, regardless of how far the two
   numbers have since drifted (`reconcileStockFromProvider`,
   `src/lib/integrations/shared/stock-reconcile.ts`). This applies
   uniformly to the routine "Synchroniser les produits" action (bulk and
   real-time single-product paths alike) and closes the Shopify
   `inventory_levels/update` webhook as a mutation path entirely — that
   webhook is still accepted, replay-protected, and audited for
   observability, but never calls `reconcileStockFromProvider` at all.

### Order lifecycle → stock effect (every source alike)
| Transition | Effect |
|---|---|
| NOUVELLE | none |
| → CONFIRMEE | reserve (`quantityReserved` only) |
| → EN_PREPARATION | none |
| → **EXPEDIEE** | **fulfill**: `quantityReserved -= qty`, `quantityOnHand -= qty` |
| → LIVREE | none |
| Pre-ship → ANNULEE | release the reservation only |
| Post-ship → ANNULEE | **no stock effect** |
| → RETOUR | **no stock effect** — label only |
| → ECHEC (from EXPEDIEE) | none (already consumed) |

`EXPEDIEE` is now the single physical-fulfillment event, full stop, for
`INTERNE`, `WOOCOMMERCE`, and `SHOPIFY` orders alike — this is the one
real behavior change from ADR 0030/32a. Since ASODITECH's own stock is now
never overwritten by a provider's number, there is no more reason to
distinguish a provider order's fulfillment from an internal one: both
physically consume ASODITECH's own authoritative on-hand, and both push
the resulting sellable number back out to the store. The existing
`shippedAt`-based idempotency guard (unchanged) still makes a carrier
-failure retry loop (`EXPEDIEE → ECHEC → EN_PREPARATION → EXPEDIEE`)
consume stock exactly once.

`pullStockBeforeReservationRelease` and its provider-specific
counterparts (`pullStockForWooCommerceOwner`/`pullStockForShopifyOwner`)
are deleted entirely — with EXPEDIEE fulfilling locally for every source,
there is no remaining reason to import the provider's own stock number at
all, targeted or otherwise.

### Physical-return model
Stock is credited back ONLY through a new, explicit, auditable action —
`confirmPhysicalReturnAction` (`src/actions/returns.ts`) — fully decoupled
from `Order.status`. It never reads or writes `Order.status`, and no
status transition ever calls it implicitly.

- **`OrderReturn`** — one row per physical-return *event* (a single
  "goods received back" moment, possibly covering several lines).
  `@@unique([orderId, idempotencyKey])` is the idempotency guard — a retry
  of the exact same client-supplied key is a silent no-op, never a second
  event or a second set of movements (same convention as
  `WebhookEvent.deliveryId`).
- **`OrderReturnLine`** — one row per `(return event, order item)`,
  carrying `quantitySellable` and `quantityDamaged` independently (DB
  `CHECK`: both ≥ 0, not both zero) plus a name/SKU snapshot (same
  convention as `OrderItem`) so history reads correctly even after the
  underlying product/variation is deleted, and its own `warehouseId` for
  traceability.
- **`InventoryMovement.orderReturnId`** (nullable FK) links a return
  -produced movement back to the exact event/line that created it — no
  second ledger, the same `InventoryMovement` table every other mutation
  uses.
- **Sellable vs. damaged**: a sellable unit is credited to `quantityOnHand`
  via a `RETOUR` movement (unchanged movement type); a damaged unit is
  recorded in `quantityDamaged` only — **never** added to `quantityOnHand`
  — via an `ENDOMMAGE` movement. This reuses `ENDOMMAGE`'s *existing*
  `damagedDelta` mechanic for a new semantic case (a unit that came back
  damaged) rather than changing what an `ENDOMMAGE` movement means
  elsewhere.
- **Hard, transactional ceiling.** What EXPEDIEE physically consumed for
  an order item (its own `quantity` — no split-shipment support, see
  below) minus what every prior `OrderReturnLine` already recorded for
  that item is the *remaining* returnable quantity. A submitted request
  whose lines would exceed it is rejected **in full** — never partially
  applied. This is enforced **inside the transaction**, not merely
  client-side: a `SELECT … FOR UPDATE` on the `orders` row (the same
  technique `createRefundAction` already uses for its own amount-cap
  race) serializes every concurrent physical-return submission for one
  order, so two simultaneous requests can never both read the same
  "remaining" figure and both apply — the second is blocked until the
  first's transaction (and its newly inserted `OrderReturnLine` rows) has
  committed.
- Supports multiple partial return events over an order's lifetime, and a
  single event mixing sellable and damaged units for the same line.
- `orders.return` is a new permission, gating the action and its UI,
  mirroring `orders.refund`'s role grants (OWNER/ADMIN/ALL, MANAGER) —
  deliberately separate from `orders.edit`, so editing an order's workflow
  status never implicitly grants physical inventory credit.

### External store relationship
A connected store is a data *source* for orders/products, never a stock
*authority* past onboarding, and never drives ASODITECH's own fulfillment:

- **Product/variant sync** initializes a missing `InventoryItem` once;
  never touches an existing one again, on any run, bulk or single-item,
  scheduled or webhook-triggered.
- **The Shopify `inventory_levels/update` webhook** is accepted and
  logged for observability but never mutates `InventoryItem`.
- **A store status that would map to EXPEDIEE is never auto-applied.**
  `updateExistingOrder` in both `src/lib/integrations/shopify/sync/
  orders.ts` and (symmetrically, for a future-proofed guard, even though
  no live WooCommerce status maps there today)
  `src/lib/integrations/woocommerce/sync/orders.ts` explicitly blocks a
  transition into `EXPEDIEE` driven by the store's own status — no
  mutation, local workflow left exactly where it was — and instead
  surfaces a new `INCOHERENCE_WORKFLOW` notification
  (`notifyWorkflowMismatch`, `src/lib/notifications.ts`) to `orders.view`
  holders. The same helper covers the more general case: a terminal
  external status (`LIVREE`/`REMBOURSEE`/`ANNULEE`) arriving before
  ASODITECH's own workflow has caught up to a stage that transition is
  even valid from. One standing, deduplicated notification per order
  (`dedupeKey` on the order id — not a status/day bucket, since the
  underlying disagreement is one ongoing fact, not a recurring one),
  resolved automatically the moment the local workflow next advances
  (`updateOrderStatusAction`/`cancelOrderAction` call
  `resolveNotifications` on every successful transition).
- **Push stays one-way and now source-agnostic.** After any local
  mutation that changes the sellable number — an order's
  reservation/fulfillment at any lifecycle stage, a physical return, a
  manual adjustment, a stocktake close-out, a transfer — ASODITECH pushes
  its own number outward via the existing `pushStockAfterLocalChange`,
  for every order source alike. The `source === "INTERNE"` guards that
  used to gate this push (added under ADR 0030 specifically because the
  provider's own number was still trusted as potentially "more recent")
  are removed: there is no more provider number to accidentally
  overwrite, because it is never pulled back in after onboarding. The
  existing manual "Pousser le stock" escape hatch is unchanged and still
  the answer to a push that failed or was missed.

## Rejected alternatives
- **Keep reconciling on every sync, but only downward (never upward).**
  Rejected — still lets an external number silently correct ASODITECH's
  own ledger, just in one direction; the actual bug (trusting the
  provider's number over the local one) remains.
- **Auto-flip `Order.status` to RETOUR/REMBOURSEE when a physical return is
  confirmed.** Rejected for v1 — the physical fact and the financial/
  workflow label are deliberately kept separate; a merchant may want a
  return recorded before deciding the commercial outcome (replace, refund,
  store credit). A later phase could offer this as an explicit, optional
  action, but the inventory primitive itself must stay decoupled either
  way.
- **A dedicated advisory lock (`pg_advisory_xact_lock`) for the
  return-ceiling race**, mirroring `reconcileOrderCommission`'s per-order
  lock. Rejected in favor of the `SELECT … FOR UPDATE` row lock already
  established by `createRefundAction` for the structurally identical
  "cap a running total under concurrency" problem — one fewer pattern in
  the codebase for the same class of race.
- **A second, physical-return-specific inventory ledger.** Rejected —
  `applyPhysicalReturnLine` is a thin wrapper over the existing
  `applyStockMovement`, and `InventoryMovement.orderReturnId` traces a
  movement back to its return event without introducing a parallel table.

## Consequences / tradeoffs
- **A genuine overselling window is accepted, unchanged from ADR 0030.**
  Stock is reserved only at CONFIRMEE, not at order creation — a flood of
  NOUVELLE orders for the last few units can still all show as available
  until confirmed. This ADR does not change that; it only changes what
  happens once an order actually ships.
- **No split-shipment support.** An order item's physically-consumed
  quantity is always its own full `quantity` once the order has shipped —
  there is no partial-EXPEDIEE concept. A merchant who ships a five-unit
  line in two parcels still records it as one full consumption at
  EXPEDIEE; any partial physical return against it is still correctly
  capped, but the "consumed" side of that cap cannot itself be partial in
  this version.
- **Provider-order fulfillment moves earlier and becomes unconditional.**
  A WooCommerce/Shopify order's on-hand is now deducted the moment
  ASODITECH itself marks it EXPEDIEE — which may be before or after the
  store's own fulfillment record, depending on how promptly staff work the
  queue. This is a deliberate trade: ASODITECH's own workflow, not the
  store's timing, now owns the physical event.
- **Workflow-mismatch notifications require a human to resolve them.**
  There is no automatic reconciliation path once a store and ASODITECH
  disagree — by design (the entire point is that only ASODITECH's own
  workflow may cause a physical stock effect), but it does mean a merchant
  who ignores the notification simply has a locally-stale order status
  until someone acts.
- **No queue/retry system for a failed push.** Consistent with the
  existing design (ADR 0030): a push failure is logged and silent; the
  manual "Pousser le stock" action remains the recovery path. Not
  revisited in this phase.
