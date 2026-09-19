# ADR 0039 — Permission overrides + channel scope (read AND write authorization)

## Status
Accepted (2026-09-19). Extends ADR 0003 (static role matrix) and ADR 0037
(location access) — it does not replace either.

## Context
Authorization was a static, code-defined role → permission matrix
(`ROLE_PERMISSIONS`) enforced by `requirePermissionForAction` / `requirePermission`
(157 call sites) and 71 UI `hasPermission(role, …)` checks, plus `UserLocation`
(ADR 0037) for warehouse-scoped **mutations only** — list/detail visibility and
every report were deliberately left role-based. Two new requirements break that:

1. One employee needs one extra capability ("Sara, a confirmation agent, may
   also edit orders") without minting a new role for everyone.
2. Online and Offline are different businesses run by different people: an
   Online partner must not see Offline data and vice-versa — through lists,
   details, dashboards, reports, exports, search, notifications, audit and AI —
   not merely be unable to click.

## Decision

### Effective permissions
```
effective = ( rolePermissions ∪ GRANTs − DENYs )  filtered by channel scope
```
- The role matrix stays the code-defined **baseline** (unchanged;
  `roleHasPermission`/`hasPermission(role, …)` remain for pure-role callers).
- `UserPermissionOverride(user, permission, GRANT|DENY)` records how ONE user
  differs from their role. One row per `(user, permission)`; the permission is a
  plain string validated against the code-defined `PERMISSIONS` on write **and**
  on read (an unknown/removed string is ignored, never trusted).
- **DENY always wins** — over a GRANT and over the role.
- **OWNER/ADMIN are never narrowed** (an override row targeting them is inert,
  and the actions refuse it) — lock-out protection, and their behaviour stays
  exactly as before, with zero extra queries.
- `users.manage` can never be overridden: granting it would let a non-admin
  edit these very overrides and mint themselves an admin.
- Permissions stay **action-based** `resource.action` strings (already the
  convention); "module" is just the UI grouping prefix, and per-record rules are
  handled by scope, not by per-record ABAC. New: `suppliers.*`, `purchases.*`
  (`.pay` separate from `.create` — a reception and a payment are different
  events), `sales.view/create/return/override_price`, `channels.manage`.

### Channel scope (`UserChannel`)
Mirrors `UserLocation`: OWNER/ADMIN need no row (tenant-wide by role); every
other role's access is *exactly* its rows; **zero rows = zero channels**
(default-deny). Every permission may carry a **channel domain**
(`PERMISSION_CHANNEL_DOMAIN`): `orders.*`, `delivery.*`, `commissions.*`,
`integrations.*`, `marketing.*` are ONLINE; `sales.*` is OFFLINE; everything
else is SHARED. Channel scope is applied to the effective set: a user with no
ONLINE channel simply holds no ONLINE-domain permission and vice-versa — a GRANT
can never bypass scope.

### Where it is enforced (server-side, three layers)
1. **Session resolution.** `getCurrentUser()` computes the effective set once
   per request (`loadEffectiveAccess`) and returns it as `user.permissions` /
   `user.channels`. `requirePermission*`, every UI visibility check
   (`userHasPermission`), the sidebar, the AI tool list, the docs "try now"
   links and **notification recipient lists** (batch-loaded) all read it. So
   every page, Server Action and route handler already gated on a permission is
   scoped for free — no per-query patching of ~60 order readers.
2. **Row scope on Offline data.** Every Sale/return read filters by
   `salesChannelId ∈ user's OFFLINE channels` (`saleChannelWhere`); writes go
   through `requireChannelAccessForAction`. A user assigned to Store A never
   sees Store B, even with `sales.view`.
3. **Shared surfaces that mix activities** are gated explicitly:
   - `analyses`, `finance`, and every order-derived report (and their CSV export)
     require an ONLINE channel (`requireChannelKind`);
   - the dashboard's finance KPIs/chart need ONLINE; its audit feed and the
     audit log are filtered by `auditScopeWhere` (Online / Offline / shared
     events classified by entity type and action prefix);
   - customer order history/aggregates and product sales stats need the
     ONLINE-domain `orders.view` / an ONLINE channel;
   - AI tools that read order data carry `domain: "ONLINE"`;
   - Online-only nav items are hidden (convenience only — the page re-checks).

### New users
A user created by accepting an invitation, if not OWNER/ADMIN, starts on the
tenant's **default ONLINE channel** — today's behaviour (a new agent can work
orders). This differs from `UserLocation` (no auto-grant) on purpose: Online is
the base business, and a zero-channel new user would see nothing. Admins widen or
narrow it per user from `/utilisateurs`.

### Existing users
The channels migration backfills every non-OWNER/non-ADMIN user onto the default
ONLINE channel, and overrides start empty — so effective == role, exactly as
before.

## Rejected alternatives
- **Postgres RLS on channel columns** (an `app.channel_ids` GUC). Powerful and
  default-deny, but it lives inside the tenant-isolation layer (ADR 0026), which
  is the most sensitive part of the system and is verified against a
  transaction-pooled connection; changing it for this increment was judged a
  higher risk than the permission-domain + row-scope design. It remains a
  possible later hardening.
- **A new role per employee variant.** The problem statement.
- **Patching every order query with a channel filter.** ~60 readers in 26 files;
  leak-prone. Filtering the *permission set* by channel covers them by
  construction.
- **Per-record ABAC.** Not needed: scope (channel/location) already expresses
  every per-record rule the business asked for.

## Consequences / known limits
- **Per-online-channel granularity** for order surfaces other than Sales is
  kind-level (Online vs Offline), not per Online channel: only one Online
  channel can exist today (one WooCommerce + one Shopify integration per
  tenant, ADR 0038). Row-level `orderChannelWhere` exists for when a tenant
  gains several Online channels; it is not yet applied to the ~60 order readers.
- **Location visibility is still not read-scoped** (ADR 0037 §6, unchanged). A
  location shared by both channels shows both activities' movements to anyone
  who may read that location's stock history — mitigated by the traceability
  view filtering movements by the viewer's channel scope (ADR 0040), and by
  recommending one location per channel.
- Effective permissions are recomputed per request, so an admin's change applies
  on the affected user's next request; nothing is cached across requests.

## Addendum — business mode (ADR 0041)
The effective-permission engine now takes the tenant's business mode as a third input. In `ONLINE_ONLY` tenants the Offline-era permissions are removed for every role (OWNER/ADMIN included), `UserChannel` rows are ignored (a user with no channel rows keeps the historical Online access — no lock-out), and overrides may not target an unavailable permission (a DENY still works). In `ONLINE_AND_OFFLINE` this ADR applies unchanged. See `docs/adr/0041-tenant-business-mode.md`.
