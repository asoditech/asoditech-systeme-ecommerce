# Analytics — metric definitions

Source of truth for every figure under `/analyses` and in its CSV exports
(`/analyses/export/<type>`). The same definitions are rendered in-app under
« Définitions des indicateurs » (`src/lib/analytics/definitions.ts`). Design
and authorization: `docs/adr/0051-analytics-performance-intelligence.md`.

Conventions
- **Periods**: today, yesterday, last 7 days, last 30 days (default), current
  month, previous month, custom range. Server-local days, both ends inclusive
  (`resolveDateRangePreset`, the same convention as /livraison and /rapports).
  Buckets are daily, or monthly beyond 62 days.
- **Comparison** with the previous period of the same length is shown only
  when both periods hold at least 20 events (`meaningfulDelta`).
- **Durations** are computed only from real timestamps; an order missing one
  of the two dates is excluded and the sample size is shown. Mean and median.
- **Permissions**: every figure needs `analytics.view`; then Online figures
  need an ONLINE channel, store figures an OFFLINE channel (rows limited to the
  viewer's stores AND locations), commissions `commissions.view`, cost /
  margin / profit `finance.view` (never computed without it).
- **Tenant**: every read goes through the tenant-scoped Prisma client + RLS.

## Online — "placed cohort"

Population: Online orders whose `placedAt` (the date the customer placed the
order — WooCommerce/Shopify `date_created`, or creation time for a manual
order) is in the period, narrowed by the origin / Online channel filters.

| Metric | Formula | Exclusions / notes |
|---|---|---|
| Orders | count | all statuses |
| Confirmed | status ∈ {CONFIRMEE, EN_PREPARATION, EXPEDIEE, LIVREE, ECHEC, RETOUR, REMBOURSEE} **or** `confirmedAt` set | ECHEC/RETOUR/REMBOURSEE are only reachable after confirmation. A reopened order (ADR 0049) is unconfirmed again |
| Confirmation rate | confirmed ÷ orders | NOUVELLE orders stay in the denominator (shown as "encore à confirmer") |
| Shipped (cohort) | status ∈ {EXPEDIEE, LIVREE, ECHEC, RETOUR, REMBOURSEE} or `shippedAt` set | |
| Delivered / Cancelled / Failed / Returned | CURRENT status LIVREE / ANNULEE / ECHEC / RETOUR+REMBOURSEE | |
| Delivery rate (overview) | delivered ÷ shipped (cohort) | |
| CA commandé (placed revenue) | Σ `Order.total` | excludes ANNULEE, ECHEC, RETOUR, REMBOURSEE (`REVENUE_EXCLUDED_STATUSES`, same as Finance and the sales report) |
| CA livré (delivered revenue) | Σ `Order.total` of cohort orders currently LIVREE | same cohort, NOT orders delivered in the period |
| Average order value | placed revenue ÷ orders counted in it | |
| Units sold | Σ `OrderItem.quantity` of orders counted in placed revenue | |
| Returned value | Σ `Order.total` of cohort orders currently RETOUR/REMBOURSEE | |
| Refunded | Σ `Refund.amount` with status COMPLETE on cohort orders | Finance's attribution rule (the order's period) |

## Confirmation

| Metric | Population | Date | Formula |
|---|---|---|---|
| Entered | placed cohort | `placedAt` | count — includes orders entered « client déjà confirmé » (ADR 0046) and imports |
| Confirmed / rate | placed cohort | `placedAt` | as above |
| Cancelled before confirmation | placed cohort | `placedAt` | ANNULEE with no `confirmedAt` |
| Attempts | `OrderConfirmationAttempt` | attempt `createdAt` | count, by outcome |
| Confirmation time | orders confirmed in the period | `confirmedAt` | `confirmedAt − placedAt`, mean + median |
| Confirmed without confirmer | orders confirmed in the period | `confirmedAt` | no CONFIRME attempt on record (imports, pre-ADR-0045 history) — attributed to no one |
| Per confirmer | attempts in the period | attempt `createdAt` | the user who RECORDED the attempt (`agentUserId`) — never the order creator, never the commission agent. Own time = their CONFIRME attempt date − `placedAt` |

The confirmer filter narrows attempts, the per-confirmer table and the
confirmation time; the cohort (entered / rate) is not per confirmer.

## Delivery

Population: Online orders whose `shippedAt` is in the period (set by the
« Expédiée » action, or when the carrier moves the parcel to EN_TRANSIT).

| Metric | Formula |
|---|---|
| Shipped | count |
| Delivered / Failed / Returned / In progress | CURRENT status: LIVREE / ECHEC or ANNULEE (only reachable after ECHEC) / RETOUR or REMBOURSEE / anything else |
| Delivery, failure, return rate | each ÷ shipped |
| Confirmed → shipped | `shippedAt − confirmedAt` |
| Shipped → delivered | `deliveredAt − shippedAt`, delivered orders only |
| Confirmed → delivered | `deliveredAt − confirmedAt`, delivered orders only |
| Carrier | provider of the order's latest shipment, excluding API-creation failures that never reached a carrier (ADR 0031) |

Not included: carrier costs (finance data — the delivery report shows them
with `finance.view`).

## Products

| Metric | Population | Date |
|---|---|---|
| Units, orders (distinct), revenue — Online | lines of placed-cohort orders counted in placed revenue | `placedAt` |
| Units, sales (distinct), revenue — store | lines of POS sales in the viewer's stores and locations | `soldAt` |
| Returned units | physical returns received (`OrderReturn` / `SaleReturn`), sellable + damaged | `receivedAt` of the return — may concern an earlier sale |
| Cost, gross profit (`finance.view` only) | Σ (`costSnapshot` × quantity); revenue − cost | not computed when a line has no cost snapshot ("coût manquant") |

Grouped by product + variation, and by category.

## Commissions

Read-only over the `CommissionEntry` ledger; date = the entry's `createdAt`.

| Metric | Formula |
|---|---|
| Earned | Σ EARNED amounts (written at LIVREE, agent's snapshot rate) |
| Reversed | Σ |REVERSED amounts| (written when a delivered order leaves LIVREE) |
| Net | earned − reversed |

Nothing is recomputed: an agent deactivated after attribution keeps the
entries the ledger gave them; a later rate change never alters an entry.

## Store (Offline POS)

Population: `Sale` rows in the viewer's OFFLINE channels AND locations,
`soldAt` in the period (the existing channel-report definition, reused).
Gross = Σ `Sale.total`; refunds = Σ `SaleReturn.refundAmount` received in the
period; net = gross − refunds; average sale = gross ÷ sales. No confirmation
or delivery metric exists for a store sale.

## Known data limits (reported, not guessed)

- WooCommerce/Shopify sync status changes do not stamp lifecycle timestamps.
  An order imported directly as delivered has no `shippedAt` / `deliveredAt`
  and is absent from the delivery population. An order moved to LIVREE by a
  sync lacks `deliveredAt`, so it is excluded from delivery durations
  (it still counts as delivered).
- Orders auto-confirmed by a store sync in trust mode have no confirmation
  attempt: they count as confirmed but are « sans confirmateur enregistré ».
- There is no order status history table; outcomes are the CURRENT status of
  the population, never a reconstructed past state.
