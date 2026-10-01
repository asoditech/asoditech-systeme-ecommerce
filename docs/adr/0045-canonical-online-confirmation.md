# ADR 0045 — One canonical Online-order confirmation (Phase 6B)

## Status
Accepted (2026-09-30). Builds on ADR 0022 (confirmation commission), 0029
(confirmation workflow) and 0030 (reservation at confirmation). No schema
change, no migration.

## Context
Two paths moved an Online order NOUVELLE → CONFIRMEE. The confirmation queue
recorded the confirmer (an `OrderConfirmationAttempt`), `confirmedAt`, the
reservation and default commission attribution; the direct status change on the
order page (`orders.edit`, held by the CONFIRMATION role too) set `confirmedAt`
and reserved stock but left no confirmation history and no attribution. Reopening
a cancelled order also kept its old `confirmedAt` and agent.

## Decision
- **`confirmOnlineOrderInTx`** (`src/lib/order-confirmation.ts`) is the only way
  to confirm. It runs inside the caller's transaction: Online + NOUVELLE check,
  race-safe conditional NOUVELLE → CONFIRMEE (+ `confirmedAt`, attempt counters),
  one CONFIRME `OrderConfirmationAttempt` whose `agentUserId` is the real
  confirmer, the reservation via the existing `reserveStockForOrder`, and default
  attribution.
- **Both paths use it**: the queue's CONFIRME outcome and `updateOrderStatusAction`
  when the target is CONFIRMEE. Every other outcome/transition is unchanged.
- **Confirmer ≠ commission agent.** The confirmer is always recorded (attempt
  history). Attribution is set to the confirmer's `CommissionAgent` only if that
  agent is **active** and the order has **no** attribution yet; the write is
  conditional, so a concurrent manager assignment is never overwritten. No agent
  id is read from a confirmation request, and no agent record is ever created.
  Manager assignment/reassignment (`commissions.manage`) is unchanged.
- **Reopen** (ANNULEE → NOUVELLE, `reopenOrderAction`) resets the current
  confirmation state: `confirmedAt = null`, `confirmationAgentId = null`. Attempt
  rows, audit events and the commission ledger are never touched; the reopen
  audit event records the values it cleared.
- Commission is unchanged: callers still run `reconcileOrderCommission` after
  commit; EARNED/REVERSED, rate snapshot, uniqueness and locking are untouched.

## Consequences
- A direct confirmation now appears in the confirmation history and counts as a
  queue-touched order (`confirmationAttemptCount` > 0).
- An **inactive** commission agent is no longer auto-credited when confirming
  (previously `isActive` was not checked).
- Not changed here: WooCommerce/Shopify status sync (a store status can still
  move ANNULEE → NOUVELLE through the state machine without this reset), manual
  "already confirmed" creation, and presetting an agent at order creation.
