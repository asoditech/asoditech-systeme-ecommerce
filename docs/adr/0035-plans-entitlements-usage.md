# ADR 0035 — Plans, Entitlements & Usage (Phase 6 — the commercial layer)

## Status
Accepted (2026-09-12). Builds on ADR 0023-0027 (multi-tenant foundation,
context, isolation, RLS, provisioning) and reuses ADR 0016 (notifications)
and the existing audit trail rather than introducing parallel mechanisms.

## Context
The platform now needs a real commercial foundation: two paid plans
(BUSINESS, PRO), each with its own prices, resource limits, and feature
set; a way to meter a tenant's actual usage against those limits without
inventing a second source of truth; a way to warn a tenant before a limit
bites, and to block the resources it's safe to block; and a platform-admin
surface to assign/change plans and see every tenant's standing at a
glance. No payment processor exists or is simulated — every transition
here is a deliberate platform-admin (or, for an upgrade request,
tenant-owner) action today, shaped so a future Stripe integration can
drive the same states without a redesign.

## Decision

### 1. `Plan` — a global catalogue, not tenant data
`Plan` carries no `tenantId` — exactly like `Tenant` itself, it sits
*above* the tenant boundary. The existing tenant-isolation Prisma Client
Extension (`src/lib/tenant/extension.ts`) only touches models with a
`tenantId` field (discovered from the DMMF, ADR 0024) — `Plan` therefore
passes through it untouched everywhere, with zero special-casing, the same
way `Tenant` already does. It carries `code` (`BUSINESS` / `PRO` /
`CUSTOM`), `installationPriceMad` / `monthlyPriceMad` (informational —
no billing automation reads or writes these), nullable `maxOrdersPerMonth`
/ `maxUsers` / `maxWarehouses` (`null` = unlimited, reserved for `CUSTOM`,
never null for BUSINESS/PRO), and a `features` JSONB blob validated
against `src/lib/entitlements/catalogue.ts`'s `planFeaturesSchema` in code
— not one boolean column per feature — so the feature catalogue can grow
without a migration, the same reasoning as `Integration.config`.

**`CUSTOM` is modeled, never offered.** The brief is explicit: keep
BUSINESS and PRO as the only real plans, leave room for a future
enterprise plan without building or exposing it. `listOfferedPlans()`
(`src/lib/entitlements/plan.ts`) is the only plan-listing function this
phase builds, and it filters `CUSTOM` out everywhere a tenant or platform
admin picks a plan (`/platform/plans`, the client comparison) — nothing
in the UI can select or display it. A future phase introducing it for
real would add a `listAllPlans()`-style query deliberately at that point,
not speculatively now.

### 2. `TenantSubscription` — one row per tenant, deliberately separate from `Tenant.status`
One row per tenant (`@unique tenantId`, the same singleton-per-tenant
convention as `BusinessSettings`), tenant-scoped and RLS-protected exactly
like every other tenant-scoped table (ADR 0026). `SubscriptionStatus`
(`TRIALING` / `ACTIVE` / `PAST_DUE` / `CANCELED`) is a **commercial/
billing** state — it never by itself blocks login or access. `Tenant.status`
(`ACTIVE` / `SUSPENDED`, ADR 0027) remains the one hard access gate,
completely unchanged and unweakened. A tenant can be `Tenant.status =
ACTIVE` while `PAST_DUE` on billing; a platform admin decides, as a
separate deliberate action (`suspendTenantAction`, unchanged), whether
that warrants an actual lockout. `updateSubscriptionStatusAction`
(`src/actions/plans.ts`) never touches `Tenant.status`.

Every tenant always has exactly one subscription row — no nullable "no
plan assigned" state exists anywhere in the app:
- The migration backfills one (BUSINESS/ACTIVE) for every tenant that
  already existed when it ran.
- `provisionTenantBaseline` (`src/lib/tenant/provision.ts`) creates one
  for every newly-provisioned tenant, alongside its default warehouse and
  settings.
- `getTenantPlan()` (`src/lib/entitlements/plan.ts`) falls back to
  BUSINESS, with a one-time `console.warn`, for the one remaining case —
  a fixture tenant created directly (`prismaBase.tenant.create(...)`,
  bypassing normal provisioning) in a test — rather than throwing. This
  mirrors `resolveActiveTenant`'s own bootstrap-fallback philosophy (ADR
  0024): defaulting sensibly is safer than crashing every unrelated code
  path that happens to touch such a tenant, and it kept this entire
  feature additive to the ~90 pre-existing test files that create a
  second tenant this way without knowing about subscriptions.

### 3. The RBAC / entitlement split
Two independent questions, both checked where it matters:

```
hasPermission(user.role, "orders.create")   — is THIS USER allowed?
checkEntitlement(tenant, "orders")          — does THIS TENANT'S PLAN include it?
```

`src/lib/entitlements/checks.ts` exports `checkEntitlement` /
`requireEntitlement` (non-throwing / throwing, mirroring
`hasPermission`/`requirePermissionForAction`'s exact shape) and
`getFeatureTier`/`requireAdvancedTier` for the three tiered features.
Neither replaces RBAC — `createOrderAction` calls both
`requirePermissionForAction("orders.create")` and
`requireEntitlement(tenant, "orders")`, independently, exactly as the
brief's own example specifies.

**The feature catalogue** (`src/lib/entitlements/catalogue.ts`,
`FEATURE_KEYS`) covers orders/users/warehouses/woocommerce/shopify/
reports/profitability/backup/aiAssistant/integrations/notifications/
commissions/finance. `reports`, `profitability`, and `backup` carry a
tier (`"standard"` | `"advanced"`) rather than a boolean, matching the
commercial table (Business = standard, Pro = advanced); every other key
is `true` on **both** plans today. This is deliberate: the brief is
explicit that Business must remain a genuinely useful, full product, not
a crippled tier — nothing already shipped is retroactively gated behind
"advanced" in this phase. The tier is modeled, validated, and shown in
the UI (client usage page, `/platform/plans`); `requireAdvancedTier()` is
a real, callable enforcement point for a future genuinely-advanced-only
capability, applied to nothing yet.

### 4. Usage metering — live, indexed counts, never a maintained counter
`src/lib/entitlements/usage.ts` computes every number from the
authoritative tables directly:
- **Orders** — `COUNT(*) FROM orders WHERE tenantId = ? AND placedAt IN [period)`,
  one calendar month at a time. `placedAt` (not `createdAt`) is the
  bucketing field deliberately: a WooCommerce/Shopify import backfills
  the source platform's real order date into `placedAt`, so importing
  three years of history attributes each order to its own historical
  month rather than inflating the current month's usage the instant a
  sync runs (ADR 0002's own `placedAt` vs `createdAt` distinction).
  Every order that was ever created counts exactly once, **regardless of
  its current status** (cancelled/refunded included) — it represents a
  real event that happened; re-deriving "does this still count" from a
  mutable status would make a month's usage silently change long after
  the fact. No double-counting is possible by construction: every
  creation path (`createOrderAction`, and both WooCommerce/Shopify
  import pipelines) is already idempotent by `(tenantId, source,
  externalId)` / one insert per form submission — a `COUNT` of rows is
  never a count of retries.
- **Users / Warehouses** — point-in-time headcounts (`COUNT ... WHERE
  status = 'ACTIVE'` / `isActive = true`), not monthly — these are
  seat/capacity limits, not a monthly throughput metric. Deactivating a
  user or warehouse frees its slot immediately.
- **Storage** — always `null`. No file/object storage exists anywhere in
  this codebase to meter (product images are external URLs; backups are
  downloaded or pushed to the tenant's own Google Drive, never stored
  server-side) — the UI renders an honest "non applicable" rather than
  fabricating a number, per the project's Data Integrity Principle.

**Deliberately no `UsageCounter`/snapshot table.** A stored, incrementally
-maintained counter can drift from reality (a retried request, a
rolled-back transaction, a bug) — the brief is explicit that usage must
be based on authoritative database state. A live `COUNT` against the same
rows the rest of the app already treats as authoritative cannot drift, by
construction, and — with the composite index added to `orders`
(`@@index([tenantId, placedAt])`) — is a single indexed range scan, not a
table scan, regardless of how many other tenants' orders exist.
`getUsageForAllTenants()` computes the platform-wide overview with three
`groupBy` aggregates (one per metric, across every tenant at once) — never
one query per tenant, so `/platform` stays fast at 10, 50, 100, or 500
tenants (see §8 "Scaling").

### 5. Limit behaviour — why orders are soft, users/warehouses are hard
Centralized thresholds (`src/lib/entitlements/catalogue.ts`):
`WARNING` at 80%, `CRITICAL` at 90%, `LIMIT_REACHED` at 100%+ —
`computeUsageStatus(used, limit)`, pure and unit-tested.

**Orders are never blocked.** The commercial table itself says
"approximately 1,500/month" — an imprecise, capacity-planning number, not
a hard cap — and the brief's own product principle ("your business is
growing, not: quota exceeded, goodbye") makes blocking the core
revenue-generating action indefensible: a merchant must always be able to
take a customer's order. Exceeding the monthly order count only ever
produces a status/alert; `createOrderAction` and both WooCommerce/Shopify
import paths (manual sync **and** webhook) never refuse a create for this
reason.

**Users and Warehouses are hard limits**, enforced server-side at the
actual write path — a deliberate, manual "invite a user" / "add a
warehouse" action, not a UI-hidden button:
- `createWarehouseAction` (`src/actions/warehouses.ts`) and
  `acceptInvitationAction` (`src/actions/invitations.ts`, the *actual*
  user-creation point — `inviteUserAction` only gives an earlier,
  non-authoritative warning) both go through
  `withSeatLimit(tenantId, resource, create)` (`src/lib/entitlements/checks.ts`).
- **Race safety**: `withSeatLimit` runs the count-then-create inside one
  `prisma.$transaction`, first locking the `Tenant` row
  (`SELECT ... FOR UPDATE`) — the same "lock the Tenant row" idea
  `src/lib/tenant/numbering.ts` already uses for atomic per-tenant
  counters, adapted here for a count-then-compare instead of a plain
  increment (a stored counter isn't safe for users/warehouses, which can
  also be deactivated — only a derived `COUNT` can't drift). Two
  concurrent requests for the same tenant serialize on that lock; the
  second re-counts against the now-committed state and correctly refuses
  if the first already filled the last seat — verified by genuine
  `Promise.all`/`Promise.allSettled` concurrency tests, not reasoned
  about (`tests/lib/entitlements.test.ts`,
  `tests/actions/warehouses.test.ts`, `tests/actions/invitations.test.ts`).
- **A real bug found and fixed while building this**: `withSeatLimit`
  originally read the plan via the standalone `getTenantPlan()` helper,
  which uses `prismaBase` (the RLS-bypass client). Calling a *different*
  `PrismaClient` instance's bypass path from **inside** an already-open
  `prisma.$transaction` callback hits a genuine edge case in the RLS
  transaction-nesting logic (ADR 0026 §3's `isInsideRlsTransaction`
  marker is keyed off the async context, not the specific client
  instance): the nested `prismaBase` call saw the marker already set,
  skipped (re-)setting its own bypass GUC, and ended up with **neither**
  `app.bypass_rls` nor `app.tenant_id` set on its own connection — RLS's
  default-deny then returned zero rows, silently falling back to
  BUSINESS's limits even for a tenant genuinely on PRO. Fixed by reading
  the plan through `tx` itself (`tx.tenantSubscription.findUnique(...)`,
  `tx.plan.findUniqueOrThrow(...)`) — the same connection/transaction
  that already has the correct `app.tenant_id` GUC set, needing no bypass
  at all. Caught by this feature's own concurrency/limit tests, not
  discovered later.
- **Shopify's Location sync is deliberately exempt** from the hard
  warehouse limit (`src/lib/integrations/shopify/sync/locations.ts`): it
  mirrors real locations the merchant already operates on Shopify —
  refusing to import one because of a plan limit would silently break
  inventory tracking for a location that genuinely exists. Going over the
  limit this way is still visible (usage page, platform overview); it is
  simply never blocked. The hard limit only ever applies to a deliberate,
  manual "add a warehouse" action in this app's own UI.

### 6. Alerts — request-driven, de-duplicated, reusing the existing notification engine
No background job/cron system exists anywhere in this codebase (confirmed
repo-wide). `UsageAlertState` (tenant-scoped, RLS-protected) holds
`highestThresholdNotified` per `(tenant, metric, period)` — `period` is a
calendar month for `ORDERS`, the literal string `"current"` for `USERS`/
`WAREHOUSES` (point-in-time metrics have no month to bucket by).
`checkAndNotifyUsageThreshold()` (`src/lib/entitlements/alerts.ts`) is
called **request-driven**, right after any write that could move a
metric across a threshold (an order created, an invitation accepted, a
warehouse created) — the exact same pattern `checkAndNotifyLowStock`
already established for inventory (ADR 0016). It only ever advances
`highestThresholdNotified` upward, which is what makes a page refresh or
an unrelated write in the same period a cheap no-op instead of a repeat
alert, and reuses `notify()` (one new `NotificationType`,
`USAGE_LIMIT_ALERT`) and `recordAuditEvent()` (`usage.threshold_reached`)
rather than inventing a parallel delivery mechanism.

### 7. Platform administration
`/platform` (existing tenant list) gains plan/subscription/usage columns
and a "Gérer le forfait" dialog per tenant
(`src/components/platform/tenant-plan-dialog.tsx`) — plan and
subscription-status changes are two independent controls, matching §2's
Tenant.status/SubscriptionStatus separation. `/platform/plans`
(`src/actions/plans.ts`, `updatePlanAction`) is the centralized place a
platform admin edits a plan's price/limits/features — a change applies
immediately to every tenant on that plan, since there is no per-tenant
override; the UI says this plainly. Every mutation is
`requirePlatformAdminForAction`-gated — the exact same flag-based gate
ADR 0027 established, reused unchanged, not a new permission concept —
and audited (`plan.assigned` from `provisionTenantBaseline`'s automatic
default, `plan.changed`, `subscription.activated`/`.suspended`/
`.canceled`, `usage.threshold_reached`, `upgrade.requested`), written
with `previousValue`/`newValue` for a real before/after history. **Plan
history reuses the existing, tenant-scoped `AuditEvent` trail rather than
a new parallel table** — "who changed a tenant's plan and when" is
already exactly what that table is for.

**Downgrade safety** (`changeTenantPlanAction`): reassigning a tenant to
a plan it's currently over the limits of always succeeds and never
deletes or disables anything already there — `previewTenantPlanChange()`
computes and surfaces the over-limit warning for the confirmation dialog,
but the actual reassignment is unconditional. Only **future** creation of
a new user/warehouse is refused afterward, by the same `withSeatLimit`
guard every creation already goes through — verified with a dedicated
test that downgrades a 17-active-user tenant from PRO to BUSINESS and
asserts every account is still there, still `ACTIVE`.

### 8. Client-facing usage dashboard
"Paramètres → Abonnement & Utilisation" (`src/app/(protected)/parametres/abonnement/page.tsx`)
is read-only for every role that can view Paramètres — a tenant can never
change its own plan or limits, only request an upgrade
(`requestPlanUpgradeAction`, `settings.manage`-gated, matching every
other billing-adjacent action in this app). Written in plain French for
a non-technical business owner: real numbers, progress bars, and the
🟢🟠🔴⚫ indicator set the brief specified — never "quota exceeded" or
similar developer-facing wording. No online payment exists — an upgrade
request creates a real `SupportTicket` (reusing the same queue "Signaler
un problème" already feeds) and is forwarded by email exactly like any
other reported issue, so an operator has something concrete to act on;
the copy says plainly that a human will follow up.

## What this explicitly does NOT do
No payment processor integration of any kind — every state here is
platform-admin- or tenant-owner-triggered today, shaped (a real
`SubscriptionStatus` enum, a real audit trail, a real per-tenant limit
model) so a future Stripe webhook can drive the same states without a
schema change. No per-tenant limit override independent of its assigned
plan — the only way to change a tenant's limits is to change which plan
it's on. No custom/enterprise plan actually offered or assignable
(`CUSTOM` exists in the schema only). No hard gate on any currently-
existing report/profitability/backup capability behind the "advanced"
tier — that tier is modeled and displayed, not enforced against anything
built before this phase. No background job/cron/scheduled re-evaluation
of usage or alerts — everything is request-driven, consistent with the
rest of this codebase's "no fake cron" posture (see the Backup module,
ADR 0034, for the identical stance). No trial-expiry automation —
`trialEndsAt` is stored but nothing reads it to auto-transition a
subscription.

## Consequences
- Every tenant answers, at any moment, without ambiguity: which plan
  ("`getTenantPlan`"), what it includes ("`checkEntitlement`" /
  `features`), how much it has used ("`getTenantUsage`"), how much
  remains (`limit - used`, or "illimité"), whether it's approaching a
  limit (`computeUsageStatus`), who changed its plan and when (the audit
  trail), whether a given user can do a given thing (RBAC, unchanged),
  and whether the tenant's plan allows a given feature (entitlements) —
  the exact list of questions the brief closes on.
- **Zero regression**: this feature is purely additive to the schema (one
  new global table, two new tenant-scoped tables, one composite index, one
  new notification-type enum value) and to application code — no existing
  model, migration, or business rule changed shape. The full pre-existing
  test suite (1292 tests as of this phase, up from 1246) passes unmodified.
- **New adversarial coverage**: tenant isolation for the two new
  tenant-scoped tables (RLS + app-level), the RBAC/entitlement dual-check
  demonstrated end-to-end on `createOrderAction`, concurrent seat-limit
  enforcement (both warehouses and invitation acceptance), alert
  de-duplication and escalation, downgrade-without-deletion, platform-only
  access to every plan control, and a larger-volume (300+ order)
  correctness/performance sanity check for the usage query.
- A client relying on backups (ADR 0034) or usage limits (this ADR) both
  now share the same underlying philosophy: compute from authoritative
  state, never fabricate, never silently delete data because of a
  plan/backup operation.
