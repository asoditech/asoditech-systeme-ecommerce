# ADR 0016 — In-app notifications (Phase 25)

## Status
Accepted (2026-09-02)

## Context
The initial scaffold already shipped the *shape* of an in-app notification
inbox: the `Notification` model, `NotificationType` enum, the
`markNotificationReadAction` / `markAllNotificationsReadAction` Server
Actions, and the full UI (`NotificationBell` in the header, the
`/notifications` page, `getRecentNotifications`). None of it was wired to
anything — no code anywhere created a `Notification` row, so the bell was
permanently empty. This phase builds the missing half: a fan-out engine
and its wiring into the real business events staff already care about
(new orders, low stock, failed deliveries, failed syncs, …), reusing the
inbox that already existed rather than redesigning it.

A `dedupeKey String?` column + `@@unique([userId, dedupeKey])` constraint
were added ahead of this phase (see the migration
`20260901234900_notification_dedupe_key`) specifically to make concurrent
fan-out safe — see below.

## Decision

### 1. `notify()` — the fan-out engine (`src/lib/notifications.ts`)
One business event becomes one `Notification` row per eligible recipient,
via a single `prisma.notification.createMany({ skipDuplicates: true })`.
Three rules, non-negotiable:

- **Best-effort, never blocking.** `notify()` catches and logs every
  error internally — it must never roll back or fail the business action
  that triggered it. Every call site invokes it *after* its own
  transaction/audit event, exactly where `recordAuditEvent` already sits.
- **Concurrency-safe without a lock.** Recipients are computed from
  `dedupeKey`. `@@unique([userId, dedupeKey])` (Postgres allows multiple
  `NULL`s, so a keyless ad-hoc notification is never constrained) plus
  `skipDuplicates: true` makes a retry, a webhook racing a manual sync, or
  two concurrent requests hitting the same event a silent no-op — the
  same pattern this codebase already uses for shipment/order state
  transitions (conditional `updateMany` + row count), applied to inserts
  instead.
- **No new data exposure.** Recipients are every `ACTIVE` user who holds
  the event's own read permission (`orders.view`, `inventory.view`,
  `delivery.view`, `integrations.view`) — never a hand-picked list, never
  a permission wider than what the entity already requires to view.
  Titles/messages are app-authored French sentences built only from
  fields the recipient could already read; never a credential, secret,
  token, URL, or raw external (WooCommerce/Shopify/carrier) payload.
  `exceptUserId` drops the actor who just caused the event — they don't
  need to be told what they did.

### 2. Eight typed helpers — a closed set, matching the existing enum
`notifyNewOrder`, `notifyPaymentProblem`, `notifyOrderReturned`,
`notifyShipmentFailed`, `notifySyncFailure`, `notifyConnectionError`, and
`checkAndNotifyLowStock` (which resolves to `RUPTURE_STOCK` or
`STOCK_FAIBLE` depending on the item's `lowStockThreshold`). These map
1:1 onto the `NotificationType` enum already in the schema — no new enum
value was added this phase (see "Deferred").
`checkAndNotifyLowStock` and `notifyConnectionError` bucket their
`dedupeKey` by UTC day (`<event>:<entityId>:<YYYY-MM-DD>`) so a
persistently-low item or a repeatedly-failing connection alerts once per
day, not on every request; one-shot events (a new order, a returned
order, a failed shipment) key on `<event>:<entityId>` alone, since that
event happens at most once per entity.

### 3. Wiring — every call site, and why each recipient set was chosen
| Event | Type | Call site | Recipients |
| --- | --- | --- | --- |
| Order created (manual) | `NOUVELLE_COMMANDE` | `createOrderAction` | `orders.view` |
| Order imported (WooCommerce/Shopify, sync **or** webhook — same `createImportedOrder`) | `NOUVELLE_COMMANDE` | `.../sync/orders.ts` `createImportedOrder` | `orders.view` |
| Order shipped, stock now low/out | `STOCK_FAIBLE`/`RUPTURE_STOCK` | `updateOrderStatusAction` (→ `EXPEDIEE`) | `inventory.view` |
| Order returned | `COMMANDE_RETOURNEE` | `updateOrderStatusAction` (→ `RETOUR`) | `orders.view` |
| Payment failed | `PROBLEME_PAIEMENT` | `updateOrderPaymentStatusAction` (→ `ECHEC`) | `orders.view` |
| Manual stock adjustment drops item low/out | `STOCK_FAIBLE`/`RUPTURE_STOCK` | `adjustInventoryAction` | `inventory.view` |
| Provider stock-pull reconciliation drops item low/out | `STOCK_FAIBLE`/`RUPTURE_STOCK` | `reconcileStockFromProvider` (shared, both providers) | `inventory.view` |
| Shipment failed (manual status change or "sync now") | `ECHEC_LIVRAISON` | `updateShipmentStatusAction`, `syncShipmentStatusAction` | `delivery.view` |
| Delivery-provider connection test failed | `ERREUR_INTEGRATION` | `testDeliveryProviderConnectionAction` | `delivery.view` |
| WooCommerce/Shopify connection test failed | `ERREUR_INTEGRATION` | `test{WooCommerce,Shopify}ConnectionAction` | `integrations.view` |
| WooCommerce/Shopify sync run ended ECHEC/PARTIEL | `ECHEC_SYNCHRONISATION` | `runSync` (both integrations) | `integrations.view` |

Two of these rows are **new wiring added this phase**, not pre-existing:
imported-order notifications (`createImportedOrder`, both providers) and
the stock-reconciliation low-stock check
(`reconcileStockFromProvider`). Shopify's connection/sync notifications
were also added this phase — `src/actions/woocommerce.ts` already called
`notifyConnectionError`/`notifySyncFailure`, but `src/actions/shopify.ts`
was a structurally identical file that had never been given the same
two calls. Every other row already existed from the prior session.

Deliberately parallel to `reserveStockForOrder`/`fulfillStockForOrder`'s
own comment: a WooCommerce/Shopify order import does **not** call
`checkAndNotifyLowStock` itself (the order's stock impact already
happened on the provider's side, reflected in via the separate
stock-pull reconciliation, not by re-deriving it from the imported
order's line items — re-deriving it would double-alert against the same
units the reconciliation pass already covers).

### 4. RBAC — no new permission
Notifications need no `notifications.*` permission of their own: a
recipient only ever gets an event they could already see via an existing
read permission (see the table above), and every inbox action
(`markNotificationReadAction`, `markAllNotificationsReadAction`,
`getRecentNotifications`) is scoped to `where: { userId: user.id }` —
already true before this phase, unchanged. Reading/marking-read one's own
inbox is not audited: it is unauthenticated-to-others personal UI state
with no security or business consequence, unlike every audited action in
this codebase (credential changes, provider CRUD, status transitions).

### 5. UI — unchanged
`NotificationBell` and `/notifications` (both pre-existing) needed no
changes: `NOTIFICATION_TYPE_LABELS` already covered all eight enum
values, and both already render `dedupeKey`-agnostic `Notification` rows.
This phase is entirely about populating rows that already had somewhere
to go.

## Test matrix
`tests/lib/notifications.test.ts` (new): `notify()`'s permission-scoped
fan-out, `exceptUserId` exclusion, `ACTIVE`-only recipients,
dedupe-on-retry via `skipDuplicates`, concurrent duplicate calls
resolving to exactly one row per (user, key), each of the seven typed
helpers' title/message/type/dedupe shape, and `checkAndNotifyLowStock`'s
threshold math (`RUPTURE_STOCK` at `≤ 0`, `STOCK_FAIBLE` otherwise,
untracked items skipped, day-bucketed re-fire).

`tests/lib/stock-reconcile.test.ts` (new): `reconcileStockFromProvider`'s
create/reconcile/unchanged outcomes (previously untested) plus the new
low-stock notification firing only on a downward reconciliation that
crosses the threshold.

New assertions added to existing suites at each new/previously-untested
call site: `tests/actions/orders.test.ts` (new order, returned, payment
failed), `tests/actions/inventory.test.ts` (low stock on adjustment),
`tests/actions/delivery.test.ts` (shipment failed),
`tests/actions/delivery-provider.test.ts` (connection error),
`tests/actions/woocommerce.test.ts` / `shopify.test.ts` (connection
error, sync failure), `tests/webhooks/woocommerce.test.ts` /
`shopify.test.ts` (new order via webhook).

## Deferred (explicitly, not silently)
- **New `NotificationType` values** — e.g. a manifest-generation failure
  (`docs/adr/0015-delivery-manifest.md`) has no notification today. The
  eight existing enum values were treated as a closed set for this phase;
  adding one is a schema migration + its own small wiring change, not
  bundled in here to keep this phase's diff reviewable as "wire the
  events that already have a type."
- **Any delivery channel beyond in-app** — no email/SMS/push/webhook
  fan-out. `notify()`'s signature does not preclude adding one later.
- **Per-user notification preferences** (mute a type, digest instead of
  real-time) — every eligible recipient gets every event today.
- **Un-reading a notification / deleting one** — only mark-read exists,
  matching the pre-existing actions.
- **A delivery-provider webhook HTTP route.** `handleDeliveryWebhook`
  (`src/lib/integrations/delivery/service.ts`, Phase 22) has no route
  handler calling it — unlike WooCommerce/Shopify, no carrier push
  webhook is wired to an endpoint yet, so `ECHEC_LIVRAISON` today only
  fires from the two reachable paths (manual status change, manual
  "sync now"). Pre-existing gap from Phase 22, out of scope here — wiring
  a new HTTP route is not a notifications change.
