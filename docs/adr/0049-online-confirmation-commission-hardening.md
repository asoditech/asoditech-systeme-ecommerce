# ADR 0049 — Online confirmation + commission hardening (Phase 6D)

## Status
Accepted (2026-10-01). Builds on ADR 0022 (commission), 0045 (canonical
confirmation), 0046 (« client déjà confirmé »). No schema change, no migration,
no new permission.

## Context
An order's **current** confirmation state is `confirmedAt` + the current
commission attribution `confirmationAgentId`. Its **history** is the
`OrderConfirmationAttempt` rows, the audit events and the commission ledger
(`CommissionEntry`, which carries its own `agentId`). The creator, the
confirmer and the commission agent are separate concepts.

The audit found three gaps:
1. Two attribution entry points accepted an **inactive** agent: the manager
   assignment (`assignOrderConfirmationAgentAction`) and the agent preset at
   manual order creation. The canonical confirmation already required an
   active agent.
2. `ANNULEE → NOUVELLE` reset the current confirmation state only through
   « Rétablir la commande ». The same transition through the **status menu**
   (`updateOrderStatusAction`, reachable from the UI) and through a
   **WooCommerce / Shopify sync** wrote only `status`. The order went back to
   the queue still carrying the previous `confirmedAt` and agent, and those two
   paths also skipped the "never reopen a shipped order" rule.
3. The rest of the domain is sound (see Commission below).

## Decision
- **One rule for a NEW attribution:** `findAssignableCommissionAgent()`
  (`src/lib/commissions.ts`) — the agent must exist in the acting tenant and be
  ACTIVE. It is used by the manual-order preset (on top of the existing
  `commissions.manage` check) and the manager assignment. The canonical
  confirmation keeps its own equivalent check on the confirmer's agent.
  Re-submitting an order's **current** agent is not a new attribution and stays
  allowed even after deactivation. Nothing is ever created or rewritten:
  deactivating an agent keeps its orders, its entries and its totals.
- **One reopen:** `REOPEN_ORDER_DATA` + `isReopenable()`
  (`src/lib/order-confirmation.ts`) are used by « Rétablir », the status menu
  and both syncs. NOUVELLE always means `cancelledAt`, `confirmedAt` and
  `confirmationAgentId` are null; only a cancelled order never shipped may
  reopen. A sync that would reopen a shipped order skips the transition with a
  reason. History is untouched: attempts, audit events, ledger, creator,
  `placedAt` and the external identity. The status-menu reopen is audited like
  « Rétablir » (`metadata.reason: "reopen"`, previous values recorded).
- **Reconfirmation** goes through the canonical confirmation as usual: a NEW
  attempt, a new `confirmedAt` and a new attribution if the new confirmer has
  an active agent.

## Commission (unchanged, verified)
- Earned only at LIVREE, at the agent's rate at that moment (snapshot).
  Reversed once when the order leaves LIVREE. At most one EARNED and one
  REVERSED per order (unique index), under a per-order advisory lock, so
  reconciliation is idempotent.
- An agent deactivated **after** an order was attributed to them still earns
  it at LIVREE: earning is not a new attribution, and the earning rule is
  unchanged.
- LIVREE can only lead to RETOUR → REMBOURSEE, never to ANNULEE. A reopenable
  order was therefore never delivered and holds no commission entry, so
  reopen + reconfirm can never duplicate or strand a ledger entry.

## Not changed (known)
- With a store's `forceNouvelleOnImport: false` (explicit opt-out), a sync may
  still move NOUVELLE → CONFIRMEE from the store's own status. That writes no
  `confirmedAt`, no attempt, no attribution and no reservation; it is the
  documented trust-the-store setting (ADR 0030 addendum), not a confirmation
  by a person.
