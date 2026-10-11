# Analytics — metric definitions

> **Unified definitions (2026-10, S6).** Every label below means the same
> thing on every screen — dashboard, Finance, /analyses, /rapports,
> /livraison. The formulas live in `src/lib/metrics/formulas.ts`; the
> in-app « ⓘ » explanations (what / how / worked example) in
> `src/lib/metrics/glossary.ts`, whose examples are computed with those same
> functions. `tests/lib/metrics-consistency.test.ts` checks one seeded month
> across every surface. The section « Unified definitions » at the end of
> this file is authoritative where an older table row differs.

Source of truth for every figure under `/analyses` and in its CSV exports
(`/analyses/export/<type>`). The same definitions are rendered in-app under
« Définitions des indicateurs » (`src/lib/metrics/analytics-explanations.ts` — français / arabe, exemples calculés sur le jeu fictif `src/lib/metrics/example-dataset.ts`). Design
and authorization: `docs/adr/0051-analytics-performance-intelligence.md`.

Conventions
- **Periods**: today, yesterday, last 7 days, last 30 days (default), current
  month, previous month, custom range. Days of the tenant's business time
  zone (`BusinessSettings.timezone`, « Africa/Casablanca » by default —
  `src/lib/time/zoned.ts`), both ends inclusive (`resolveDateRangePreset`,
  the same convention as /livraison and /rapports). Buckets are daily, or
  monthly beyond 62 days.
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
| Confirmed | `confirmedAt` set (the order's confirmation stands) | An order that reached Échec / Retour without ever being confirmed is not counted. A reopened order (ADR 0049) is unconfirmed again |
| Confirmation rate | confirmed ÷ orders that went through confirmation (≥ 1 `OrderConfirmationAttempt`, or `confirmedAt` set) | Orders nobody has called yet stay out of the denominator (« À confirmer ») — `confirmationRatePct` |
| Shipped (cohort) | status ∈ {EXPEDIEE, LIVREE, ECHEC, RETOUR, REMBOURSEE} or `shippedAt` set | |
| Delivered / Failed / Returned | final delivery outcome of the shipped cohort orders (`orderDeliveryOutcome`): the order's current shipment (newest real parcel — an API-creation failure is never one), or the order's own status when it has no shipment; a recorded RETOUR / REMBOURSEE wins | In transit / waiting / cancelled = no outcome |
| Cancelled | CURRENT status ANNULEE | |
| Delivery rate (overview) | delivered ÷ (delivered + failed + returned) — « Taux de livraison réussie » (`deliveryOutcomeRate`) | Orders without an outcome yet stay out of the denominator |
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
| Delivered / Failed / Returned / In progress | final outcome per order (`orderDeliveryOutcome`): the order's current shipment (newest real parcel, API-creation failures excluded), else the order's own status; a recorded RETOUR / REMBOURSEE wins over the parcel's « Livré ». « In progress » = no outcome yet (in transit, waiting, or cancelled without a failed parcel) |
| Delivery, failure, return rate | each ÷ (delivered + failed + returned); « in progress » stays out of every rate |
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


## Unified definitions (S6, 2026-10)

| Label | Definition | Population / date | Notes |
|---|---|---|---|
| Chiffre d'affaires | Σ order totals (delivery fee charged to the customer included, discounts deducted) − COMPLETE refunds on those orders | Orders placed in the period (`placedAt`), not Annulée / Échec / Retour / Remboursée | Refunds are attributed to the refunded order's period. Dashboard headline, its chart and sparkline, Finance, /analyses, /rapports/ventes and /rapports/canaux all show this net figure. |
| CA produits | Σ order-line totals | Same orders | /rapports/rentabilite, /rapports/profitabilite: no delivery fee, no order-level discount, no refund (refunds are not recorded per product — data-model limit). |
| Commandes | Count of orders placed, any status | `placedAt` | The revenue-order count is only used for the average basket. |
| Panier moyen | Gross total of the revenue orders ÷ their count | `placedAt` | Refunds are later events and do not shrink the basket. |
| Confirmées | Orders whose confirmation stands (`confirmedAt` set) | `placedAt` | An order that reached Échec / Retour without ever being confirmed is not counted. |
| Taux de confirmation | Confirmées ÷ orders that went through confirmation (≥ 1 `OrderConfirmationAttempt`, or confirmed on import) | `placedAt` | Orders nobody has called yet stay out (they are « À confirmer »). |
| Confirmées ce mois / aujourd'hui | Distinct orders with a « Confirmé » attempt in the business-time-zone month / day | attempt `createdAt` | Was a count of attempt rows. |
| Taux de livraison réussie | Delivered ÷ (delivered + failed + returned), one final outcome per order | Order screens: shipped orders placed in the period; delivery screens (/livraison, dashboard, /rapports/livraison): orders with a shipment created in the period | Outcome = the order's current shipment (the newest real parcel — a failed API creation attempt is never one), or the order's own status when it has no shipment; a recorded Retour / Remboursée wins. In transit and cancelled = no outcome. Delivery screens count shipments, so an order handled with no shipment record appears only on the order screens. |
| Commandes expédiées (/livraison) | Orders with a shipment created in the period, counted once (their current shipment) | `Shipment.createdAt` | Replaced attempts are history (« Afficher l'historique ») and never counted twice; costs keep every attempt. |
| Nouveaux clients | Buyers of the period (a revenue order in it) whose first-ever order is in the period | `placedAt` | Never the date the customer record was created or imported. |
| Remboursé | Σ COMPLETE refunds of the period's orders | order `placedAt` | Same in /analyses and /rapports/tresorerie. |
| Coût de livraison (Finance, dashboard « Charges ») | Σ recorded shipment costs of the orders placed in the period, every attempt included | order `placedAt` | Matched to the revenue it served; cancelled shipments and cancelled orders excluded. /rapports/livraison keeps a per-shipment view (shipments created in the period). |
| Produits en stock faible | Stock rows (article × active location) whose AVAILABLE stock (physique − réservé) ≤ the product's threshold | now | Same rule as the low-stock alerts (`checkAndNotifyLowStock`, which additionally skips products with `trackInventory` off) and the /stock « Stock faible » badge and « Stock faible » / « Rupture » filters (inactive locations left out there too). One article in two locations counts twice. |
| À encaisser (/rapports/tresorerie) | Totals of the period's orders still En attente / Partiellement payé, excluding Annulée / Échec / Retour / Remboursée | `placedAt` | A partly paid order counts its full total: the amount already paid is not recorded (data-model limit, shown on the card). |
| Gagnée ce mois / Reste à payer (dashboard) | EARNED entries of the business-time-zone month / Σ over every agent (active or not) of earned − reversed − paid | entry `createdAt` | Same as /analyses and /commissions. Payout closing keeps its own calendar months. Agents paid in different currencies are summed as is (limit). |
