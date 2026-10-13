# Decision required — four order-sync semantics (WooCommerce + Shopify)

Status: **open, nothing changed** (2026-10-13). The safe guards already in
place stay active meanwhile (`src/lib/integrations/shared/order-sync-rules.ts`,
ADR 0030 addendum 2026-10-13). None of the options below needs a schema
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
