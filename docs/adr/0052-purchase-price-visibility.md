# ADR 0052 — Purchase prices follow `purchases.view`

## Status
Accepted (2026-10-01). Revises the cost part of ADR 0048 (Store Manager:
"no purchase prices without finance.view") and refines ADR 0043. The Store
Manager permission set and its 11 DENYs are unchanged (`finance.view` stays
denied). No schema change, no migration, no new permission.

## Decision
`productCostVisibility(user)` now returns three distinct flags:

| Flag | Rule | Covers |
|---|---|---|
| `cost` | `finance.view` | `Product.cost` / `ProductVariation.cost` (the margin / COGS basis), stock valuation at cost, product cost editing |
| `purchasePrices` | `purchases.view` | reception unit prices and totals (list, detail, new / edit form), the last-purchase hint and purchase-price history (actions + product page + supplier page line history), the supplier page's reception totals, a **RECEPTION** movement's unit cost in traceability |
| `supplierAccounts` | `finance.view` AND `purchases.view` | supplier balances, received / paid / owed amounts (supplier list and detail), a reception's paid / remaining amounts, purchase payments |

Whoever runs receptions sees what was paid per unit; the company's debt to
its suppliers and its payments remain finance data. In traceability, only a
RECEPTION movement's cost follows `purchases.view`; any other movement's cost
(none records one today) stays `finance.view`.

## Unchanged
- `finance.view` pages and exports: Finance, treasury, profitability,
  product profitability, margins, profit, stock valuation at cost, `/analyses`
  finance groups (ADR 0050, 0051).
- `purchases.pay` (supplier payments), `finance.manage`.
- Store Seller (no `purchases.view` → sees no purchase price), OWNER / ADMIN
  (all three flags true), Online analytics authorization.

## Consequence
The rule is permission-based: every role holding `purchases.view` without
`finance.view` now sees purchase prices — the Store Manager profile and the
WAREHOUSE role (default matrix). ACCOUNTANT and MANAGER already had both.
