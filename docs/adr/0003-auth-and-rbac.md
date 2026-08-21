# ADR 0003 — Authentication and role-based access control

## Status
Accepted (2026-08-21)

## Context
The brief requires secure login/logout, protected routes, protected server
operations, and **granular, server-enforced RBAC** across eight roles
(Owner, Admin, Manager, Sales, Warehouse, Delivery, Support, Accountant)
with permissions like `orders.cancel`, `inventory.adjust`,
`finance.manage`. This goes further than the Control Center's model, which
only distinguishes OWNER/ADMIN (full access) from everyone else (no
access, because it has no other staff-facing roles yet).

## Decision

### Session mechanism — identical to Control Center
Opaque, server-verified session tokens, not JWTs (see Control Center ADR
0003 for the full reasoning, reproduced here because it applies unchanged):
- `src/lib/auth/session.ts` generates a 256-bit random token, stores only
  its HMAC-SHA256 hash (keyed by `AUTH_SECRET`) in the `sessions` table,
  and sets the raw token as an `httpOnly`, `secure` (in production),
  `sameSite=lax` cookie named `aec_session` (Control Center uses
  `acc_session` — different name so both products' cookies can coexist in
  the same browser during development/testing).
- Every request re-verifies against the database (`getCurrentUser()`),
  checking expiry and that `User.status` is still `ACTIVE`.
- Disabling a user (`status = DISABLED`) invalidates all sessions on their
  next request; `destroyAllSessionsForUser()` gives immediate revocation
  (called from `updateUserStatusAction` when an OWNER disables an account).
- Sessions last 30 days, sliding, refreshed at most once/day.
- `src/proxy.ts` is a cheap, cookie-presence-only redirect — explicitly not
  the authorization boundary. The real boundary is `requireUser()` /
  `requirePermission()` in every protected layout, and
  `requireUserForAction()` / `requirePermissionForAction()` in every
  Server Action that mutates data.

### RBAC — the part that's new versus Control Center
`src/lib/auth/permissions.ts` defines:
- `PERMISSIONS`: the full list of granular permission strings from the
  project brief (`orders.view`, `orders.create`, `orders.edit`,
  `orders.cancel`, `orders.refund`, `customers.*`, `products.*`,
  `inventory.*`, `delivery.*`, `finance.*`, `marketing.*`, `users.*`,
  `settings.*`, `audit.view`, `integrations.*`, `ai.use`, `dashboard.view`,
  `analytics.view`).
- `ROLE_PERMISSIONS`: a **static, code-defined** role → permission matrix.
  There is no database table for permissions and no UI to edit the
  matrix — changing what a role can do is a code change, reviewed like any
  other authorization logic, not a runtime configuration. This is a
  deliberate scope cut: the brief asks for granular, server-enforced RBAC,
  not a permission-editor UI, and building the latter without a concrete
  need would be speculative complexity.
- `requirePermission(permission)` (pages/layouts, redirects to
  `/acces-refuse`) and `requirePermissionForAction(permission)` (Server
  Actions, throws) are the two enforcement points. **Every** Server Action
  that mutates data calls one of these — never only `requireUserForAction()`
  — except the few actions gated behind `requireOwnerForAction()`
  (user provisioning/role changes, same restriction as Control Center).
- The sidebar (`src/components/layout/sidebar-nav.tsx`) and command palette
  (`src/components/layout/command-palette.tsx`) filter their items through
  the same `ROLE_PERMISSIONS` set — but this is convenience, not the
  security boundary. Hiding a nav link does not protect the route; the
  page-level `requirePermission()` call does.

### Default role → permission matrix (see `permissions.ts` for the exact list)
| Role | Scope |
| --- | --- |
| OWNER, ADMIN | Every permission. |
| MANAGER | Full orders/customers/products/inventory/delivery/marketing, finance **view** only, no user/settings/integration management. |
| SALES | Orders (view/create/edit, not cancel/refund), customers (view/create/edit), products (view). |
| WAREHOUSE | Inventory (view/adjust), products (view), orders (view), delivery (view). |
| DELIVERY | Delivery (view/manage), orders (view). |
| SUPPORT | Customers (view/edit), orders (view). |
| ACCOUNTANT | Finance (view/manage), orders (view), analytics (view), audit (view). |

This is a first, reasonable default informed by the brief's role names and
typical Moroccan e-commerce team structure — not a business requirement
handed down explicitly. It's easy to adjust in `permissions.ts` as real
usage reveals gaps.

## Audit addendum (2026-08-21 A–G pre-integration hardening)
The pre-integration audit found that `updateOrderPaymentStatusAction`
allowed `paymentStatus` to be set directly to `REMBOURSE` by anyone holding
`orders.edit`, bypassing both `orders.refund` and the `Refund` model's own
amount validation/audit trail entirely — a caller could mark an order
refunded without ever creating a `Refund` row. Fixed by rejecting
`REMBOURSE` as a directly-settable value in that action outright (rather
than just adding an `orders.refund` permission check to it), since
`paymentStatus` reaching `REMBOURSE` should only ever be a side effect of
`updateRefundStatusAction` transitioning a `Refund` to `COMPLETE` — see
`docs/adr/0002-domain-model.md`. The UI
(`src/components/orders/order-status-control.tsx`) now shows a read-only
badge instead of an editable dropdown option once an order's
`paymentStatus` is `REMBOURSE`.

## Consequences / scope
- Password reset flow, email verification, and SSO are not implemented —
  not requested, and the seed script's "change the default password"
  reminder covers the bootstrap case.
- If Auth.js/NextAuth reaches a point where its RBAC/session primitives are
  clearly better than this hand-rolled approach, migrating is possible
  without a schema change (the `User`/`Session` tables don't assume any
  particular auth library) — but not before then, per Control Center ADR
  0003's same reasoning about not depending on unstable third-party auth
  for the most security-critical subsystem.
