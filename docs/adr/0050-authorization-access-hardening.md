# ADR 0050 — Authorization & access hardening (G4, G7, G8, G6d, G6e, finance analytics)

## Status
Accepted (2026-10-01). **Supersedes ADR 0037 §6 ("visibility stays
role-based") for location-sensitive reads.** Builds on ADR 0039 (effective
access), 0043/0048 (cost visibility), 0047 (invitation scope). No schema
change, no migration, no new permission.

## G4 — read-side location scoping
The session now carries a **location read scope**: `user.locations`
(`loadLocationScope`, one indexed query per request, none for OWNER/ADMIN).
OWNER/ADMIN are global. Everyone else reads exactly their `UserLocation` rows;
inactive locations are included, so their own history stays readable. Helpers
live in `location-access.ts` (`readableWarehouseIds`, `warehouseReadWhere`,
`canReadWarehouse`); mutations keep `requireLocationAccessForAction`.

Scoped (server-side, page and query):
- **Sales** — every read goes through `saleChannelWhere`, which now requires
  the sale's location as well (see G7): list, detail, search, channel report
  and its CSV, returns report, dashboard store summary, stock rotation.
- **Receptions** — list, detail, draft edit; supplier detail reception list,
  purchase history and activity counts.
- **Transfers** — list and detail (source **or** destination readable).
- **Stocktakes** — list and detail.
- **Traceability** — stock rows and, through them, movements and totals.
- **Products** — per-location stock on the list and the detail.
- **Locations page** — non-`warehouses.manage` users see only their own.
- Already scoped before: stock page and CSV, stock report and CSV, dashboard
  low-stock and stock overview, every stock mutation and picker.

Deliberately NOT location-scoped (tenant-level data, unchanged): the product
catalogue itself, supplier identities and supplier balances and payments
(company-wide debt, `finance.view`-gated), customers, and Online orders (the
Online business is channel-scoped; ADR 0037's rejection of location-based
order visibility stands).

## G7 — shared store channel
`SalesChannelLocation` deliberately allows one store channel to serve several
locations (e.g. a store and its stockroom). No constraint is added: since
every sale read also requires the sale's location to be one of the viewer's,
a channel shared by stores A and B no longer shows a store-A user any store-B
sale (regression-tested on list, detail, search, reports and returns).
Recommended configuration is unchanged: one store channel per physical store.

## G8 — `dashboard.view` is a real guard
`/tableau-de-bord` requires `dashboard.view` server-side. It is also the
post-login landing, so a user without it is redirected by `landingPathFor()`
to the first page their effective access opens (orders, confirmation, store
sales, stock, …), or `/acces-refuse`. Every default role holds
`dashboard.view`; only a DENY changes anything.

## G6d — no GRANT/DENY at invitation
Intentionally deferred. The post-acceptance access dialog
(`setUserPermissionOverridesAction`, `users.manage`, non-overridable
`users.manage`) is the only source of overrides. The invitation schema has no
override field, and crafted extra fields are ignored (tested): an invited
account starts with its role baseline, the chosen scope and zero overrides.

## G6e — unset scope (the existing model, now documented and tested)
- **Locations:** zero `UserLocation` rows = zero locations — no stock
  mutation (ADR 0037) and, now, no location-sensitive read. Never "all".
- **Channels (ONLINE_AND_OFFLINE):** zero `UserChannel` rows = no
  channel-domain permission (orders, confirmation, delivery, commissions,
  marketing, integrations, store sales). Non-domain permissions keep working
  on tenant-level data only. An invitation with no explicit scope still
  resolves to the default Online channel (ADR 0047, unchanged).
- **ONLINE_ONLY:** channels never apply (everyone is on the Online business);
  locations still do.
- OWNER/ADMIN: global by role, no rows needed (unchanged).

## Online analytics without `finance.view`
Cost of goods, margins, profit, expenses, carrier cost and treasury are
finance data:
- `/rapports/rentabilite`, `/rapports/profitabilite` (pages and CSVs) and the
  `tresorerie` CSV require `finance.view`; the reports index hides them
  without it.
- `/analyses` keeps revenue, the trend, breakdowns and top products, but
  without `finance.view` drops the P&L cards and the per-product
  profitability (no longer even computed).
- `/rapports/livraison` and its CSV drop carrier-cost figures; delivery
  performance and COD stay.
- AI finance tools and dashboard finance cards already required
  `finance.view` (verified).

With `finance.view`, every report, CSV and page is unchanged.
