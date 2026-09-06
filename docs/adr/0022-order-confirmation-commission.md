# ADR 0022 — Order Confirmation Commission

## Status
Accepted (2026-09-06)

## Context
Confirmation agents (confirmateurs) are paid a fixed amount per order they
own — but only for orders that actually get **delivered**. Cancelled,
refused, returned or failed orders earn nothing. Rates differ per agent
(10 / 12 / 15 MAD…) and change over time. The business needs a monthly
statement per agent, a settlement/payment workflow, and a full audit
trail. This is additive — no redesign of Orders, Delivery, Finance or RBAC.

## Decision

### 1. Data model — three tables, one nullable FK on `orders`
- `CommissionAgent` — 1:1 with `User` (`onDelete: Cascade`), carrying the
  agent's **current** `ratePerOrder` and an `isActive` flag.
- `CommissionEntry` — append-only ledger. `type` is `EARNED` (+rate) or
  `REVERSED` (−rate). `rateApplied` snapshots the rate in force when the
  entry was created, so changing `CommissionAgent.ratePerOrder` never
  rewrites history. `@@unique([orderId, type])` — at most one EARNED and
  one REVERSED per order.
- `CommissionStatement` — one frozen monthly statement per
  `@@unique([agentId, periodYear, periodMonth])`, created at close time
  with snapshot totals (`earnedCount`, `reversedCount`, `earnedAmount`,
  `reversedAmount`, `netAmount`, `paidAmount`) and a `CLOTURE → PAYE`
  status.
- `Order.confirmationAgentId String?` → `CommissionAgent` (`onDelete:
  SetNull`, like `campaignId`). The order shows who to credit; the ledger
  entry carries its own agent + rate snapshot.

### 2. `reconcileOrderCommission(orderId)` — the only writer
Idempotent, self-correcting. Given an order id it makes the ledger match
the order's current state:
- order is `LIVREE`, has an agent, no entry yet → create `EARNED`
  (snapshot `agent.ratePerOrder`).
- order was earned and is no longer `LIVREE`, not already reversed →
  create `REVERSED` (−earned amount).
- otherwise → no-op.

Runs inside a transaction holding `pg_advisory_xact_lock(hashtext(
"commission:<orderId>"))` — two concurrent order-status updates cannot
both credit the same order. `@@unique([orderId, type])` is the final
backstop (a P2002 is swallowed as "someone else already did it").

The order state machine has **no path back to `LIVREE`** (`LIVREE →
RETOUR → REMBOURSEE`), so re-earning after a reversal is impossible — the
`!hasReversed` guard is belt-and-braces.

### 3. Where it is called (best-effort, after the triggering commit)
- `updateOrderStatusAction`, `cancelOrderAction` — manual status changes.
- `applyShipmentStatusTransition` — a carrier-confirmed delivery
  (`shipment → LIVRE` auto-advances `order → LIVREE`).
- `assignOrderConfirmationAgentAction` — assigning an agent to an
  already-delivered order earns immediately.
- WooCommerce / Shopify `updateExistingOrder` — a store webhook moving the
  order in or out of `LIVREE`.

Every call is `await`ed but never allowed to fail the caller (the function
catches and logs).

### 4. Monthly settlement
`closeCommissionStatementAction(agentId, year, month)` sweeps every
not-yet-settled entry whose `createdAt` falls in that calendar month
(UTC bounds) into a new `CommissionStatement`, freezes the totals, and
stamps `statementId` on the entries — all in one transaction. Rejected if
the month hasn't started, has no entries, or is already closed
(`@@unique`). A reversal that lands **after** a month is closed simply
falls into the next open period — standard practice, no back-dating.

`markCommissionStatementPaidAction(statementId, paidAmount?)` records the
payment (`status → PAYE`, `paidAmount`, `paidAt`, `paidById`).

### 5. RBAC
Two new permissions: `commissions.view` (agents, statements, history) and
`commissions.manage` (configure agents/rates, assign an order's agent, run
the close / payment). Granted to `OWNER`, `ADMIN`, `MANAGER`,
`ACCOUNTANT`. Assigning an order's agent needs `commissions.manage`.

### 6. Audit
`commission.agent_created`, `commission.agent_updated`,
`commission.order_assigned`, `commission.statement_closed`,
`commission.statement_paid` are recorded from the actions.
`commission.earned` / `commission.reversed` are reserved for the ledger
but the entry rows are themselves the record.

## Consequences
- Historical statements never change when a rate is edited.
- A return months after delivery is handled correctly as a negative
  adjustment in the current open period.
- No new background jobs — reconciliation is inline on the events that
  already fire.
- The agent on an order is locked once any commission entry exists for it
  (server-enforced), so the ledger can never point at a different agent
  than the order shows.
