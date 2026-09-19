import type { UserRole } from "@prisma/client";

/**
 * Every permission the application checks server-side. This is the single
 * source of truth — Server Actions and Route Handlers call hasPermission()
 * or requirePermission() (see guards.ts) with one of these, never with a
 * raw role check. Sidebar/UI visibility follows from the same list so the
 * frontend never has to duplicate this logic (see
 * src/components/layout/sidebar-nav.tsx).
 */
export const PERMISSIONS = [
  "dashboard.view",
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.cancel",
  "orders.refund",
  // Confirm a physical-return event on a shipped order — credits sellable/
  // damaged units back to InventoryItem via the dedicated, auditable
  // physical-return action (docs/adr/0036-inventory-single-source-of-truth.md).
  // Deliberately separate from orders.edit: editing an order's workflow
  // status must never implicitly grant physical inventory credit. Mirrors
  // orders.refund's role grants (a comparable "financial/physical
  // consequence" action gated apart from the general edit permission).
  "orders.return",
  // Work the shared order-confirmation queue: log a call attempt, confirm
  // an order (→ CONFIRMEE, auto-credited as its confirmation agent), or
  // cancel it after a failed call (docs/adr/0029). Narrower than
  // orders.edit — the CONFIRMATION role holds this but not the full
  // status machine.
  "orders.confirm",
  "customers.view",
  "customers.create",
  "customers.edit",
  "products.view",
  "products.create",
  "products.edit",
  "inventory.view",
  "inventory.adjust",
  // Create / edit / dispatch / receive / cancel stock transfers between
  // locations (Phase 32b — docs/adr/0020-stock-transfers.md). Held by the
  // WAREHOUSE role: moving stock between locations is operational work,
  // unlike warehouses.manage (adding/retiring a location). Viewing the
  // transfer list/detail uses inventory.view.
  "inventory.transfer",
  // Create / count / finalize / cancel stocktake sessions (Phase 32c —
  // docs/adr/0021-stocktaking.md). Held by the WAREHOUSE role for the same
  // reason as inventory.adjust / inventory.transfer — counting is
  // warehouse-floor work. Viewing the stocktake list/detail uses
  // inventory.view.
  "inventory.count",
  // Create / rename / (de)activate stock locations. Deliberately NOT held
  // by the WAREHOUSE role — adjusting stock in a location is operational;
  // adding or retiring a location is an org-structure decision. See
  // docs/adr/0019-inventory-foundation.md.
  "warehouses.manage",
  "delivery.view",
  "delivery.manage",
  "finance.view",
  "finance.manage",
  // Order-confirmation commission (docs/adr/0022): `.view` sees agents,
  // statements and history; `.manage` configures agents/rates, assigns an
  // agent to an order, and runs the monthly close / payment.
  "commissions.view",
  "commissions.manage",
  "marketing.view",
  "marketing.manage",
  "analytics.view",
  "users.view",
  "users.manage",
  "settings.view",
  "settings.manage",
  "audit.view",
  "integrations.view",
  "integrations.manage",
  "ai.use",
  // Online/Offline unification (docs/adr/0038, 0039, 0040). Action-oriented,
  // like every permission above — never a UI-only label.
  //
  // Suppliers & purchase receptions. Receiving stock is warehouse-floor work
  // (`purchases.create` validates a reception → adds stock through the
  // canonical movement primitive); paying a supplier is a financial action,
  // deliberately separate (`purchases.pay`) — a reception and a payment are
  // different events.
  "suppliers.view",
  "suppliers.manage",
  "purchases.view",
  "purchases.create",
  "purchases.pay",
  // Offline (in-store) sales — a SEPARATE transaction type from Online
  // orders. `sales.override_price` lets a seller sell below/above the
  // catalogue price (the POS's "modify product price" flag).
  "sales.view",
  "sales.create",
  "sales.return",
  "sales.override_price",
  // Create/rename/(de)activate business channels and map them to locations.
  // An org-structure decision, so — like warehouses.manage's sibling — not
  // held by operational roles.
  "channels.manage",
  // Product / variant traceability page (docs/adr/0040). Held by the roles that
  // hold inventory.view and manage stock; only usable when the tenant's business
  // mode enables the `traceability` capability (docs/adr/0041).
  "traceability.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Which business activity a permission belongs to (docs/adr/0039). A user's
 * CHANNEL SCOPE (UserChannel) decides which activities they can act on, and
 * it is applied to their effective permissions: an Online-only user simply
 * does not hold any OFFLINE-domain permission, and vice-versa — so every page,
 * Server Action, AI tool and notification recipient list that already gates
 * on a permission is scoped for free, with no per-query patching.
 *
 * Permissions not listed here are SHARED (products, inventory, customers,
 * finance, analytics, users, settings, audit, suppliers, purchases…): they
 * apply to both activities, and the few shared surfaces that mix Online and
 * Offline data (dashboard, reports, search, audit, notifications) filter by
 * activity themselves — see src/lib/auth/channel-access.ts.
 */
export type ChannelDomain = "ONLINE" | "OFFLINE";

export const PERMISSION_CHANNEL_DOMAIN: Readonly<Partial<Record<Permission, ChannelDomain>>> = {
  "orders.view": "ONLINE",
  "orders.create": "ONLINE",
  "orders.edit": "ONLINE",
  "orders.cancel": "ONLINE",
  "orders.refund": "ONLINE",
  "orders.return": "ONLINE",
  "orders.confirm": "ONLINE",
  "delivery.view": "ONLINE",
  "delivery.manage": "ONLINE",
  "commissions.view": "ONLINE",
  "commissions.manage": "ONLINE",
  "marketing.view": "ONLINE",
  "marketing.manage": "ONLINE",
  "integrations.view": "ONLINE",
  "integrations.manage": "ONLINE",
  "sales.view": "OFFLINE",
  "sales.create": "OFFLINE",
  "sales.return": "OFFLINE",
  "sales.override_price": "OFFLINE",
};

const ALL_PERMISSIONS = [...PERMISSIONS];

/**
 * Default role → permission matrix. There is no dynamic permission editor
 * in this phase (see docs/adr/0003-auth-and-rbac.md) — adjusting a role's
 * access is a deliberate code change, not a UI action, so it goes through
 * the same review as any other authorization logic.
 */
export const ROLE_PERMISSIONS: Record<UserRole, readonly Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  ADMIN: ALL_PERMISSIONS,
  MANAGER: [
    "dashboard.view",
    "orders.view",
    "orders.create",
    "orders.edit",
    "orders.cancel",
    "orders.refund",
    "orders.return",
    "orders.confirm",
    "customers.view",
    "customers.create",
    "customers.edit",
    "products.view",
    "products.create",
    "products.edit",
    "inventory.view",
    "inventory.adjust",
    "inventory.transfer",
    "inventory.count",
    "warehouses.manage",
    "delivery.view",
    "delivery.manage",
    "finance.view",
    "commissions.view",
    "commissions.manage",
    "marketing.view",
    "marketing.manage",
    "analytics.view",
    "audit.view",
    "ai.use",
    "suppliers.view",
    "suppliers.manage",
    "purchases.view",
    "purchases.create",
    "purchases.pay",
    "sales.view",
    "sales.create",
    "sales.return",
    "sales.override_price",
    "traceability.view",
  ],
  CONFIRMATION: [
    "dashboard.view",
    "orders.view",
    "orders.create",
    "orders.edit",
    "orders.confirm",
    "customers.view",
    "customers.create",
    "customers.edit",
    "products.view",
    "ai.use",
  ],
  WAREHOUSE: [
    "dashboard.view",
    "orders.view",
    "products.view",
    "inventory.view",
    "inventory.adjust",
    "inventory.transfer",
    "inventory.count",
    "delivery.view",
    "suppliers.view",
    "purchases.view",
    "purchases.create",
    "traceability.view",
  ],
  DELIVERY: ["dashboard.view", "orders.view", "delivery.view", "delivery.manage"],
  SUPPORT: ["dashboard.view", "orders.view", "customers.view", "customers.edit"],
  ACCOUNTANT: [
    "dashboard.view",
    "orders.view",
    "finance.view",
    "finance.manage",
    "commissions.view",
    "commissions.manage",
    "analytics.view",
    "audit.view",
    "suppliers.view",
    "purchases.view",
    "purchases.pay",
    "sales.view",
  ],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Pure role-only check — the BASELINE. Kept (and unchanged) for tests, for
 * code that has only a role in hand, and as the input to the effective
 * computation. Anything that has a logged-in user should use
 * `userHasPermission` so per-user overrides and channel scope apply.
 */
export function roleHasPermission(role: UserRole, permission: Permission): boolean {
  return hasPermission(role, permission);
}

/**
 * Effective-permission check for a resolved user (docs/adr/0039): role
 * baseline + per-user GRANT/DENY overrides, filtered by channel scope. Pure
 * — the set was computed once, at session resolution (`getCurrentUser`).
 */
export function userHasPermission(user: { permissions: ReadonlySet<Permission> }, permission: Permission): boolean {
  return user.permissions.has(permission);
}

/** Type guard: is this arbitrary string one of the code-defined permissions? */
export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
