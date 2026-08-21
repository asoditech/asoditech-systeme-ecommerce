# ADR 0007 — Finance model and profit calculation

## Status
Accepted (2026-08-21)

## Context
The brief is emphatic on this point: never fabricate financial metrics,
never call revenue "profit," never calculate net profit unless the
required expense/cost data actually exists, and show "Non calculable" /
"Données indisponibles" rather than a fake or misleading number.

## Decision

### Revenue is derived, never stored
There is no `Revenue` table. `getFinanceSummary()`
(`src/lib/queries/finance.ts`) computes revenue as the sum of `Order.total`
for orders whose status is not `ANNULEE`/`ECHEC`, minus completed refunds
in the period. This is intentional: storing a separate revenue ledger that
must be kept in sync with `Order` would be duplicated business logic and a
source of drift bugs. "Revenue" is always a query over `Order`, never a
cached number that can go stale.

### COGS honesty: `null` means null, not zero
Cost of goods sold sums `OrderItem.costSnapshot × quantity` across the
period's revenue-generating orders. If **any** item in the period has a
missing `costSnapshot` (product cost was never entered), `cogsComplete` is
`false` and `cogs`/`grossProfit`/`netProfit` are all returned as `null` —
not `0`, not a partial sum presented as if it were the whole number. The
UI (`KpiCard`) renders `null` as "Non calculable" with a hint explaining
why ("Coût d'achat manquant sur certains produits"), never as "0,00 MAD"
— zero would falsely imply a verified zero cost. This is covered directly
by `tests/actions/finance.test.ts`: "reports COGS as null (not zero) when
no orders exist, rather than fabricating a figure."

### Net profit formula, and what it does *not* claim to be
`netProfit = (revenue − refunds) − cogs − expensesTotal − deliveryCostTotal`,
computed only when `cogsComplete`. `expensesTotal` sums whatever's been
recorded in the `Expense` table for the period — this is **recorded**
expenses, not a guarantee that every real business expense was entered.
The Finance page and dashboard both label this figure "Basé sur les
dépenses enregistrées" rather than presenting it as a complete accounting
statement. This is a deliberate middle ground: refusing to show *any* net
profit figure until every conceivable expense category has data would make
the KPI useless in practice; showing it without the caveat would overstate
its authority. The caveat is the resolution.

### Revenue vs. cost vs. expense vs. profit — kept distinct in code and copy
- **Revenue** (chiffre d'affaires) — money in, from orders.
- **Cost** (coût) — COGS, what the sold goods cost to acquire.
- **Expense** (dépense) — everything else spent (ads, packaging, salaries,
  SaaS tools — `ExpenseCategory`, seeded with the brief's suggested
  categories but fully configurable/extendable, not hardcoded business
  rules).
- **Profit** (bénéfice) — always qualified as "brut" (gross: revenue −
  COGS) or "net" (revenue − COGS − expenses − delivery cost). The word
  "profit" alone never appears unqualified in the UI.

### Period comparisons
`currentMonthRange()` / `currentQuarterRange()` / `currentYearRange()` +
`previousPeriodOfSameLength()` give month/quarter/year presets with a
trend badge (`+X%`/`-X%`) against the immediately preceding period of the
same length. Daily/weekly granularity (listed in the brief) is not built
in this phase — month/quarter/year cover the operationally meaningful
comparisons; daily/weekly can be added to the same `getFinanceSummary()`
function without a schema change when there's a concrete need.

## Deferred (explicitly, not silently)
- **Profit by product / by channel** (brief §12 mentions both). The data
  to compute these exists (`OrderItem.costSnapshot`,
  `Order.campaignId`/`source`) but the aggregation queries aren't built —
  Analytics currently shows top-selling products by units/revenue, not
  margin.
- **Daily/weekly period granularity** for the Finance page's period
  selector.
- **Marketing spend as a finance-page line item.** Marketing spend is
  tracked per-campaign (`MarketingCampaign.spend`) but not yet rolled into
  `getFinanceSummary()`'s expense total — see
  `docs/adr/0008-marketing-and-attribution.md`.
