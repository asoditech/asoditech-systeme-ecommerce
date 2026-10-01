# ADR 0046 — Manual Online order: « Client déjà confirmé » (Phase 6C)

## Status
Accepted (2026-09-30). Builds on ADR 0045 (one canonical Online confirmation)
and ADR 0030 (reservation at confirmation). No schema change, no migration.

## Context
Operators often create a manual order for a customer who has **already**
confirmed on WhatsApp, by phone, Instagram… Such an order had to be created
NOUVELLE and then confirmed a second time from the queue or the order page.

## Decision
- The manual order form offers one explicit switch, **« Client déjà confirmé »**
  (off by default). Off → the order is created NOUVELLE and enters the
  confirmation queue, exactly as before. On → it is created CONFIRMEE and never
  enters the queue.
- The client sends only the business fact (`customerAlreadyConfirmed`), never a
  status; `createOrderAction` decides. It requires `orders.confirm` on top of
  `orders.create` (the queue's own permission); the switch is only shown to
  holders of it.
- The order is confirmed by **`confirmOnlineOrderInTx` (ADR 0045) inside the same
  transaction that creates it**: CONFIRME `OrderConfirmationAttempt` whose
  confirmer is the **creator**, `confirmedAt`, the reservation, and default
  attribution (creator's **active** CommissionAgent, only when no agent is set).
  Any failure rolls the whole creation back, display number included. The
  attempt note records the external confirmation and the order's origin
  channel (`Order.channel`) — no new model.
- Presetting a commission agent at creation (the existing manager picker) is now
  also enforced server-side: refused without `commissions.manage`. A preset
  agent is kept by the confirmation (never overwritten).
- Post-commit effects mirror the other confirmation paths (audit
  `order.created` carrying `status` + `customerAlreadyConfirmed`, low-stock
  check, stock push, idempotent `reconcileOrderCommission`). No « nouvelle
  commande » alert is raised for an order that never waited for confirmation.

## Consequences
- Stock follows ADR 0030 unchanged: confirming never blocks on available stock
  (backorders allowed); the reservation is taken exactly once.
- Reopen (ANNULEE → NOUVELLE) behaves as in ADR 0045; a later confirmation is a
  new event.
- Unchanged: store imports/webhooks/sync, Offline POS, order editing, the
  commission ledger. The manager preset still accepts an **inactive** agent
  (existing behaviour, left for Phase 6D).
