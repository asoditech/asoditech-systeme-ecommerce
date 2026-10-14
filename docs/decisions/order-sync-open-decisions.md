# Decision required — four order-sync semantics (WooCommerce + Shopify)

Status: **decided and implemented 2026-10-14** (owner) — see the
« Decisions taken » section at the end and ADR 0030 addendum « 2026-10-14 ».
The matrix below is kept as the record of the options. Was: open, nothing
changed (2026-10-13). None of the options below needs a schema
migration: `Order.status`, `Order.paymentStatus` (`OrderPaymentStatus`:
EN_ATTENTE, PAYE, PARTIELLEMENT_PAYE, **ECHEC**, REMBOURSE) and `Refund` rows
are already separate concepts.

## 1. Imported payment failure (WooCommerce `failed`, Shopify `EXPIRED`)

- **Today:** imported as order status ECHEC (ADR 0030: a store may create
  ECHEC freely), no stock effect.
- **Risk:** ASODITECH's ECHEC means a failed *delivery* after EXPEDIEE
  (`RESERVED_ORDER_STATUSES` doc, `src/lib/validation/order.ts`). Staff
  retrying it (ECHEC → EN_PREPARATION → EXPEDIEE, `src/actions/orders.ts`)
  run the shipment's stock consumption (`fulfillStockForOrder`) on a
  reservation that was never taken — another order's reserved units drop.
- **Options:**
  - A. Status NOUVELLE + `paymentStatus: ECHEC` — payment failure recorded
    where it belongs; the order stays actionable (call the customer, COD
    fallback) and goes through the normal confirmation/reservation.
  - B. Status ANNULEE + `paymentStatus: ECHEC` — out of the queue;
    « Rétablir » if the customer pays later.
  - C. Keep ECHEC; refuse the manual retry when `shippedAt` is null.
- **Recommended:** A (or B if failed payments must leave the queue), plus C
  as a guard for orders already imported as ECHEC.
- **Touches:** both `mapper.ts` (`mapOrderStatus`), both `sync/orders.ts`
  (payment status at import), `src/actions/orders.ts` (guard C), ADR 0010 /
  0011 mapping tables, mapper + order-sync tests.

## 2. Delivered vs shipped (Shopify `FULFILLED`, WooCommerce `completed`)

- **Today:** both map to LIVREE. LIVREE is only reachable from EXPEDIEE, so
  the store can only « deliver » an order ASODITECH already shipped; then
  the confirmation commission is earned (ADR 0049) and `deliveredAt` set.
- **Risk:** Shopify FULFILLED means « all items fulfilled » (handed over /
  shipped), not delivered: a commission and the delivery metrics can be
  counted before the parcel arrives. WooCommerce `completed` depends on the
  merchant's own workflow.
- **Options:** A. keep; B. Shopify FULFILLED never sets LIVREE (delivery
  comes from the carrier tracking — « Suivi » — or staff), WooCommerce
  `completed` kept; C. same for both providers.
- **Recommended:** B — needs only the mapper and its tests; commission rules
  untouched.

## 3. Cancelled and refunded

- **Today:** Shopify gives cancellation priority (`cancelledAt` → ANNULEE);
  the Refund row is created with the refunded amount, but `paymentStatus`
  only becomes REMBOURSE on Shopify REFUNDED *as the status*, WooCommerce
  only on its `refunded` status. A cancelled, fully refunded order therefore
  shows ANNULEE + PAYE (or EN_ATTENTE). Finance already nets Refund rows
  (`src/lib/queries/finance.ts`).
- **Options:** A. keep; B. status stays ANNULEE, `paymentStatus` becomes
  REMBOURSE when the refunded total covers the order total (both
  providers); partial refunds unchanged.
- **Recommended:** B — order status = what happened to the order, payment
  status = the money; no migration.

## 4. Provider clock differences

- **Today:** a store cancellation of a person-confirmed order / a store
  reopen applies only when the store's modification time is strictly newer
  than `confirmedAt` / `cancelledAt`; a missing time → refused with a reason.
  WooCommerce times have 1-second precision.
- **Risk:** store clock BEHIND → a genuine store change right after a local
  decision is refused (safe: staff act). Store clock AHEAD → a slightly
  stale snapshot can look newer and be applied (unsafe).
- **Options:** A. keep strict; B. an « ambiguous zone » of ±Δ around the
  local decision where the change is refused for manual review (safe both
  ways); C. compare with the delivery's arrival time instead (loses
  meaning for retried deliveries).
- **Recommended:** B with Δ chosen by the owner (e.g. 2 minutes).

## Webhook policy choices (not changed)

- **Body size:** no limit is documented; the hosting platform's own request
  limit applies (to verify for the deployment). Choose an app limit?
- **Suspended tenant:** ADR 0053 says suspension blocks login and sessions;
  webhooks of a suspended tenant are still processed. Keep (data stays
  current for a later re-activation) or refuse (the store retries, then may
  disable the webhook)?
- **ECHEC answered 200** when the store connection has no usable
  credentials (WooCommerce) or Shopify no longer returns the resource:
  deliberate (a retry cannot succeed); confirm.

## Decisions taken (2026-10-14) — implemented, local tests only

| # | Decision | Implementation |
|---|---|---|
| 1 | **A + C**: payment failure → `NOUVELLE` + `paymentStatus: ECHEC`; held orders keep their status (EN_ATTENTE → ECHEC only); legacy never-shipped `ECHEC` cannot be retried / shipped / auto-shipped (audited refusal; recovery « Annuler » + « Rétablir ») | both mappers, both `sync/orders.ts`, `src/lib/validation/order.ts`, `src/actions/orders.ts`, `src/lib/packing.ts`, `src/lib/delivery.ts` |
| 2 | **B**: Shopify `FULFILLED` → `EXPEDIEE` (never auto-applied, never LIVREE / commission); WooCommerce `completed` unchanged | `shopify/mapper.ts`, `storeShipmentReportIsBehind` |
| 3 | **B**: `ANNULEE` kept; payment `REMBOURSE` only when COMPLETE refunds cover the total (integer cents); partial stays partial | `applyCancelledFullRefund`, `refundsCoverOrderTotal` |
| 4 | **B, Δ = 2 minutes**: newer > 2 min applied; within ±2 min (inclusive) → review + alert; older > 2 min → stale; unknown → review | `placeStoreEvent`, `storeOrderingRefusal` |
| Webhooks | 1 MiB body limit (413, before parsing / signatures); suspended company → `SUSPENDU` + 200, never processed or replayed; ECHEC + 200 for permanent failures **confirmed** | `shared/webhook-body.ts`, both routes |

Still to verify with real stores (not provable with fakes): that WooCommerce
sends `date_modified_gmt` and Shopify `updatedAt` as documented, real clock
offsets, Shopify's FULFILLED timing vs actual delivery, and the providers'
retry / disable behaviour on 200 / 413 answers.

## Payment & refund identity (2026-10-14 bis) — implemented, local tests only

| # | Owner decision | Implementation |
|---|---|---|
| 5 | A verified store payment success may change `ECHEC` → `PAYE`, subject to the refund, cancellation, ordering and idempotency protections | `applyStorePaymentEvent` (`src/lib/orders/store-payment.ts`): only with « Paiement confirmé par la boutique » ON (same opt-in as EN_ATTENTE → PAYE); never when the same snapshot reports a failure or any refund; never on an `ANNULEE` order (review); ordered against the recorded failure with the shared 2-minute rule — newer → `PAYE` (audited `store_reported_paid_after_failure`), older → stale, within ±2 min / unknown → review + « Paiement à vérifier » alert. The failure time comes from the audit trail (store failures are now audited with `metadata.storeModifiedAt`, store clock; a person's ECHEC uses its audit `createdAt`); a legacy ECHEC with no such record → review. Bulk « Synchroniser » refreshes such orders only when the opt-in is on. |
| 6 | A payment change alone never confirms, reserves or ships | Only `paymentStatus` is written; tests assert status, `confirmedAt`, stock ledger and shipments unchanged |
| 7 | Manual refunds on store orders allowed, clearly distinguished; no duplicate accounting; stable external ids where available; integer cents; manual review when identity is uncertain | Manual refunds are `source: INTERNE` (audited `refundOrigin: MANUEL`, `executedOnStore: false`; order page shows « Origine » and says a manual refund is not executed on the store). Store refunds stay ONE row per order and provider holding the store's cumulative total (rewritten, never added → duplicate deliveries cannot double count; WooCommerce refund ids de-duplicated in the sum; compared in cents). Manual cap computed in cents and includes the store's row. `refundCoverage`: a store refund and a manual refund are never added together to reach the total — « Remboursé » only when one kind alone covers it; otherwise ambiguous → nothing changed. Applies to the store sync AND to approving a refund in ASODITECH (`updateRefundStatusAction` → COMPLETE), where a partial refund no longer marks the order « Remboursé ». Whenever an order carries both kinds, a « Paiement à vérifier » alert asks a person to check (and reject the manual row if it duplicates). |
| 8 | Hide « Emballage » for a legacy never-shipped ECHEC with no stock reservation | `hiddenOrderStatusOptions` + `OrderStatusControl.hiddenStatuses`; server refusal + audit unchanged |

**Blocker (not implemented, needs a schema change):** per-refund external
identifiers. The `refunds` table has no external-id column, so individual
store refund ids are not stored; de-duplication relies on the cumulative
per-provider row (safe against duplicate deliveries) and on human review for
manual-vs-store overlap. Storing each provider refund id would need an
additive migration (e.g. nullable `externalId` + unique per order/source) —
owner approval required.

Still external: real stores' `date_paid` / `displayFinancialStatus` sequence
after a failed then retried payment, and real refund payloads (ids, signs,
currency) — not verified against a real store.
