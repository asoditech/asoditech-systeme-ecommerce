# ADR 0051 — Analytics & performance intelligence

## Status
Accepted (2026-10-01). Builds on ADR 0039 (channel scope), 0040 (Online /
Offline separation), 0045/0046/0049 (confirmation), 0022/0049 (commission
ledger), 0050 (location read scope, finance analytics). No schema change, no
migration, no new permission.

## Decision
`/analyses` becomes a sectioned, factual analytics module:

| Section | Route | Export |
|---|---|---|
| Overview | `/analyses` | `revenus` |
| Confirmation | `/analyses/confirmation` | `confirmation` |
| Delivery | `/analyses/livraison` | `livraison` |
| Products | `/analyses/produits` | `produits` |
| Origins & stores | `/analyses/canaux` | `canaux` |
| Commissions | `/analyses/commissions` | `commissions` |

Every metric has a written definition (population, date field, formula,
exclusions, permission) in `docs/analytics/metric-definitions.md`, rendered
in-app on every section. No score, no "best employee", no ranking: tables are
factual and sortable server-side.

## Authorization
One resolver, `analyticsAccess(user)` (src/lib/analytics/access.ts), computed
from the effective access already loaded for the request, used by every page
(`analyticsContext`) and by the export route:

- `analytics.view` is required for everything (the Store Seller has none →
  every section and export refused).
- **Online** order analytics need an ONLINE channel — the Online business is
  scoped by channel kind (ADR 0039); Online orders have no location model and
  none is invented (ADR 0050).
- **Store** analytics need an OFFLINE channel + the `storeChannels`
  capability; every Sale read goes through `saleChannelWhere` (channel AND
  location). The store / location filters are ANDed on top — a foreign or
  unauthorized id matches nothing. Filters narrow, never widen.
- **Commissions** need `commissions.view` (as `/commissions`).
- **Cost, COGS, margin, profit** need `finance.view` and are not computed
  without it: the product query does not even select `costSnapshot`, the P&L
  cards are not computed, and the CSV has no such columns.
- A section with nothing readable redirects to `/acces-refuse`; its export is
  a 403.

Consequences: a Store Manager (ADR 0048) now has analytics — store KPIs,
store products and per-store / per-location sales for their own locations —
and nothing Online, commission- or finance-related. The sidebar entry
« Analyses » is no longer Online-only (like « Rapports »); each section
re-checks server-side.

## Online / Offline separation
An in-store `Sale` is never read as an Online `Order`: separate queries,
separate KPI groups, separate product tables; the store has no funnel.

## Performance
Aggregation is server-side (count / groupBy / aggregate); rows are fetched
only for per-day buckets and durations, with the minimum columns. No N+1:
names are batch-loaded. Existing indexes (`placedAt`, `tenantId+placedAt`,
attempt `orderId`/`agentUserId`) cover the access paths; no index added.

## Not changed
Commission logic, confirmation logic, the Store Seller / Store Manager
policies, invitation scope, authorization hardening (ADR 0050), the dashboard.
`/rapports` reports are unchanged.

## Findings reported, not fixed here
1. **Online order reads are not row-scoped by Online channel** — by design
   (ADR 0039 rejected per-query patching): any user with an ONLINE channel
   reads all Online orders, in analytics as in the orders list. A tenant with
   several Online channels and per-channel staff would need that decision
   revisited.
2. **Store-sync status changes don't stamp lifecycle timestamps** — see
   « Known data limits » in the metric definitions.
3. **Test harness**: under vitest, a concurrent dynamic
   `import("next/headers")` (inside `resolveAmbientTenantId`) can resolve to
   the real, unmocked module, whose `cookies()` throws outside a request; the
   resolver then falls back to the bootstrap tenant. Single-tenant tests are
   unaffected (the fallback IS their tenant); a cross-tenant test that runs
   parallel queries through the session path sees the bootstrap tenant's
   rows. Production is not affected (one real module, request-scoped
   cookies). The analytics tenant test pins the tenant with `runWithTenant`.
