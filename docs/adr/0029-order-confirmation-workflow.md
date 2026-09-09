# ADR 0029 — Order confirmation workflow

## Status
Accepted (2026-09-09).

## Context
In Moroccan COD e-commerce, an order isn't real until a **confirmateur**
phones the customer and gets a "yes". Before this, ASODITECH modelled the
*outcome* (`Order.status NOUVELLE → CONFIRMEE`, a `confirmationAgentId` FK,
the delivery-time commission in ADR 0022) but not the *work*:

- no queue of orders waiting to be called;
- a confirmateur (`CONFIRMATION` role) could flip the status but couldn't
  attribute themselves — only a `commissions.manage` user could assign the
  agent, so commission tracking depended on a manager doing it by hand;
- a failed call (no answer, "call me back") had nowhere to go except a
  free-text note, so orders silently stalled with no accountability.

The owner asked for a shared pool with auto-credit and a full call-attempt
log (chosen over "manager assigns batches" and "just Confirmed/Cancelled").

## Decision

### Data model
- `OrderConfirmationAttempt` — append-only log: `orderId`, `agentUserId`
  (the caller), `outcome` (`OrderConfirmationOutcome`), optional `note`,
  `createdAt`. `onDelete: Cascade` from Order, `SetNull` from User. RLS
  `tenant_isolation` policy like every other tenant-scoped table.
- `OrderConfirmationOutcome` enum: `CONFIRME`, `PAS_DE_REPONSE`, `OCCUPE`,
  `RAPPELER`, `FAUX_NUMERO`, `ANNULE`.
- `Order.confirmationAttemptCount Int` + `Order.lastConfirmationAttemptAt
  DateTime?` — denormalised so the queue sorts by "least recently tried"
  and flags an order past `CONFIRMATION_RETRY_FLAG` (3) without an
  aggregate per row. Index `(status, lastConfirmationAttemptAt)`.

### Permission
New `orders.confirm` — held by `CONFIRMATION`, `MANAGER`, `ADMIN`,
`OWNER`. Deliberately narrower than `orders.edit`: a confirmateur works
the queue but doesn't get the full status machine.

### `recordConfirmationAttemptAction(orderId, outcome, note?)`
The single writer. Order must be `NOUVELLE` (the queue never shows
anything else). In one transaction: append the attempt, bump the two
denormalised columns, then:
- `CONFIRME` → conditional `updateMany(status: NOUVELLE → CONFIRMEE)`
  (same race guard as `updateOrderStatusAction`), set `confirmedAt`. **Auto-credit:**
  if the order has no `confirmationAgentId` *and* the caller has a
  `CommissionAgent` row, set it to that agent. A missing agent record is
  "no credit", never an error.
- `ANNULE` → conditional `updateMany(→ ANNULEE)`, `cancelledAt`, and
  `releaseStockForOrder` (a NOUVELLE order is reserved, never fulfilled).
- others → attempt logged, order stays in the queue.

After commit (best-effort, never fails the caller): audit
`order.confirmation_attempt`; on a terminal outcome resolve the
`NOUVELLE_COMMANDE` notification and run `reconcileOrderCommission`; on
`ANNULE` also push stock + order status to a linked store. Mirrors
`updateOrderStatusAction`'s side-effect list — it does **not** call that
action (kept independent so the order state machine is untouched).

### UI
- `/confirmation` — the shared queue. Every `NOUVELLE` order,
  least-recently-tried first, as mobile-friendly cards: click-to-call
  `tel:` link, item count / total / age, the last 3 attempts, a note
  field, and one-tap `Confirmer` / no-answer-kind + `Enregistrer` /
  `Annuler la commande`. Three KPIs including the caller's own
  confirmed-this-month count and potential commission (rate × confirmed —
  the *potential*, since commission only *earns* on delivery).
- Sidebar entry under "Ventes" (gated on `orders.confirm`); command-palette link.
- Order detail: "Historique de confirmation" card when the order has any
  attempts.

## Consequences
- A confirmateur is now self-sufficient: open the queue, call, tap an
  outcome, and their commission attribution happens automatically.
- Commission still only *earns* at `LIVREE` (ADR 0022 unchanged) — this
  just makes the *agent assignment* automatic instead of manual.
- `getMyConfirmationStats` gives a confirmateur a read of their own
  throughput without opening the full `/commissions` area (still gated on
  `commissions.view`).
- Files: `src/actions/order-confirmation.ts`,
  `src/lib/queries/order-confirmation.ts`,
  `src/app/(protected)/confirmation/page.tsx`,
  `src/components/orders/confirmation-queue.tsx`, migration
  `20260909150000_order_confirmation_workflow`. Tests:
  `tests/actions/order-confirmation.test.ts`,
  `tests/lib/permissions.test.ts`.
