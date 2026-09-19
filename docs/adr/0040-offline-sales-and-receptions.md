# ADR 0040 — Offline sales, suppliers & receptions, traceability views, channel reporting

## Status
Accepted (2026-09-19). Builds on ADR 0038 (channels, catalog identity, ledger
hardening) and 0039 (permission overrides + channel scope). Additive: it adds
new transaction types and read models on top of the existing inventory/order
architecture and changes none of its invariants.

## Context
The business also sells in physical stores and buys stock from suppliers. The
existing system had one canonical stock writer (`applyStockMovement`), one
ledger (`InventoryMovement`), and a delivery-based `Order` lifecycle with a
tightly coupled surface (confirmation queue, commissions at LIVREE, carriers,
COD, WooCommerce/Shopify push, the monthly-order plan cap, and every revenue
report's excluded-status logic).

## Decision

### `Sale` is a separate transaction type — `Order` is not generalised
Extending `Order` into a POS object was rejected: it would silently touch the
confirmation queue, commissions, delivery/COD code, WooCommerce push, the plan's
order cap and every revenue report; it needs a mandatory customer; and its
reserve-at-CONFIRMEE / fulfil-at-EXPEDIEE lifecycle is exactly wrong for a
cash-and-carry sale. So:

`Sale` / `SaleLine` / `SalePayment` / `SaleReturn` / `SaleReturnLine`. A sale
belongs to an OFFLINE `SalesChannel`, decrements physical stock at one
`Warehouse` mapped to that channel, has an optional customer (or a walk-in
label), records who sold it and when, and **completes atomically** — sale,
lines, payments and the canonical `VENTE` movements in ONE transaction. There is
no draft, no reservation, no carrier. The Order lifecycle, its stock rules
(ADR 0036), `orders.return` and the physical-return path are byte-for-byte
unchanged; the offline return uses a *sibling* helper (`applySaleReturnLine`).

### Stock safety — the two rules the order flow does not need
1. **Available, not merely on-hand.** A sale passes
   `applyStockMovement({ enforceAvailable: true })`, so under the row lock it may
   consume only `onHand − reserved`. Without this an offline sale at a shared
   location could take units reserved for a confirmed online order, and that
   order's later EXPEDIEE would fail. (A test proves: 10 on hand, 6 reserved →
   the sale may take 4, refuses 5, and the order still ships.)
2. **No silent no-op.** `applyStockMovement` silently returns `applied:false`
   when no `InventoryItem` exists — right for the order flow (an untracked
   product must not block an order), wrong for a completed in-store sale. A sale
   treats `applied:false` as a controlled error and rolls back.

Any failure (insufficient stock, missing stock row, payment mismatch) rolls back
everything: no completed sale, no partial decrement. Lines are applied in a
stable per-unit order to avoid lock-order deadlocks between concurrent sales.

### Idempotency
`UNIQUE(tenantId, idempotencyKey)` on `Sale` and `UNIQUE(saleId, idempotencyKey)`
on `SaleReturn` — the same convention as `OrderReturn`. The form generates one
key per attempt; a retry or double-click returns the existing document and moves
stock once. A concurrent duplicate loses on the unique index and re-reads the
winner. Receptions are idempotent by a compare-and-set on status
(`BROUILLON → VALIDEE` via `updateMany`), so a retried validation adds nothing.

### Prices
The **server** resolves the price (`variation.price ?? product.salePrice ??
product.price`). A client-supplied price or any discount that departs from it
requires `sales.override_price`. Payments must sum exactly to the total; a refund
lives on `SaleReturn` (capped by what was collected, net of earlier refunds), not
as a negative payment. **Deferred:** customer credit / on-account sales,
change-giving, cash-drawer/shifts.

### Returns
Same rules as the online physical return: stock only returns when physically
accepted; sellable units are credited to on-hand (`RETOUR`), damaged units only
to `quantityDamaged` (`ENDOMMAGE`, never on-hand); the cumulative returned
quantity per sale line is hard-capped by what was sold, under a
`SELECT … FOR UPDATE` on the sale; all-or-nothing. Scoped: a sale of a channel
the viewer cannot read is "not found".

### Suppliers & receptions
`Supplier`, `Reception` / `ReceptionLine`, `SupplierPayment`. A **reception is a
document; the movement is the authority**: validating it is the only thing that
adds stock, via `applyStockMovement` (type `RECEPTION`, carrying the line's
`unitCost`, `receptionLineId`, actor and destination location). Creating the
destination `InventoryItem` when the location did not track the unit yet uses the
existing `ensureInventoryItem`. A validated reception is **immutable** (no edit,
no delete — unlike a POS that lets you edit a received purchase); a draft can be
edited or cancelled with no stock effect. Reversing a validated reception (a
supplier return) is deferred.

A **payment is a separate financial record** from receiving. Supplier balance is
**derived** — Σ validated receptions − Σ payments — never stored; a payment
linked to a reception cannot exceed its remaining amount (row-locked).
`purchases.pay` is a distinct permission from `purchases.create`.

- **Costing.** Not decided (see "Business decisions"). `unitCost` is recorded on
  the movement and on the reception line, so the history exists for last-cost,
  weighted-average or FIFO later. **`Product.cost` is NOT changed by a
  reception** — updating it would silently change existing profit reports.
- **Finance.** Purchases are not fed to Finance/Expenses (that would double-count
  against `Expense` and is an accounting decision). No accounting is implied.

### Traceability (one ledger, no second history)
`/tracabilite`: scan a barcode/reference/name → identity (reference, barcodes,
category), where the stock is now (per location: physical/reserved/available/
damaged) and the movement history — each row with location, signed effect,
running balance, cost, actor and the SOURCE DOCUMENT (reception + supplier, sale,
sale return, transfer, stocktake, order, order return). It is a read over
`InventoryMovement`, scoped by `movementScopeWhere`: no ONLINE channel → drop
order-linked movements; no OFFLINE channel → drop sale-linked ones; some OFFLINE
channels → only sales of those channels; document-less movements (receptions,
transfers, stocktakes, adjustments, legacy rows) are shared. Legacy movements
(`onHandDelta IS NULL`) are flagged, never given an invented origin.

### Reporting: Online / Offline / Total without duplication
`/rapports/canaux` (and its CSV) is built from the underlying sources:

| | Source | Definition |
|---|---|---|
| Online | `Order` via the **existing** `getFinanceSummary` | unchanged — orders *placed* in the period, excluding cancelled/failed/returned/refunded |
| Offline | `Sale` (row-scoped) | sold in the period **minus refunds paid on returns received in the period** |
| Total | sum, no double count | only when the viewer may read BOTH |

The two recognition points genuinely differ (an online order counts when placed,
before delivery; a sale when sold), so each is reported faithfully and the Total
is labelled a sum — **no accounting policy is invented and the Online definition
is not changed**. The stock-rotation report now counts every activity the viewer
may read (Online orders + in-store sales), and none they may not; with no options
it behaves exactly as before. The dashboard shows an Offline KPI only to a viewer
who may read it and never folds it into the Online figures.

## Rejected alternatives
- **Extend `Order`** (above).
- **Edit-able validated receptions** (as OrvaLink allows): destroys traceability.
- **A payment as a negative reception / a refund as a negative payment**: conflates
  two events the requirements insist stay separate.
- **A per-channel stock bucket to "solve" reserved stock**: forbidden by the
  frozen principle; `enforceAvailable` on the one physical pool does it.

## Consequences / limits
- **Shared locations** are a pool with first-come semantics (no channel-specific
  logical allocation); recommended v1 is one location per channel (ADR 0038).
- Customer credit, supplier returns/reversals, FIFO/lots, cash-drawer, price
  tiers and multi-online-store remain deferred.
- Offline sales do not count toward the monthly-order plan cap (that counts
  `Order` rows) — a business decision is still open (see the audit report, D8).
- Actor columns on the new documents are id + name snapshot with no FK, so
  deleting a user never erases who acted (contrast with the pre-existing
  `SetNull` FKs, which are unchanged; `InventoryMovement` additionally gets a
  name snapshot at user deletion).

## Addendum — business mode (ADR 0041)
Sales, sale returns, suppliers, receptions, supplier payments and the traceability views are gated by the tenant's business mode: they are unavailable (permission absent, actions refused, navigation/search/report entries hidden) unless the tenant is `ONLINE_AND_OFFLINE`. A tenant that owns any sale, sale return, reception or supplier payment cannot be switched back to `ONLINE_ONLY`. See `docs/adr/0041-tenant-business-mode.md`.
