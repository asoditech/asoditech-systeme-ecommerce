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
  // Create / rename / (de)activate stock locations. Deliberately NOT held
  // by the WAREHOUSE role — adjusting stock in a location is operational;
  // adding or retiring a location is an org-structure decision. See
  // docs/adr/0019-inventory-foundation.md.
  "warehouses.manage",
  "delivery.view",
  "delivery.manage",
  "finance.view",
  "finance.manage",
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

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
    "customers.view",
    "customers.create",
    "customers.edit",
    "products.view",
    "products.create",
    "products.edit",
    "inventory.view",
    "inventory.adjust",
    "inventory.transfer",
    "warehouses.manage",
    "delivery.view",
    "delivery.manage",
    "finance.view",
    "marketing.view",
    "marketing.manage",
    "analytics.view",
    "audit.view",
    "ai.use",
  ],
  SALES: [
    "dashboard.view",
    "orders.view",
    "orders.create",
    "orders.edit",
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
    "delivery.view",
  ],
  DELIVERY: ["dashboard.view", "orders.view", "delivery.view", "delivery.manage"],
  SUPPORT: ["dashboard.view", "orders.view", "customers.view", "customers.edit"],
  ACCOUNTANT: [
    "dashboard.view",
    "orders.view",
    "finance.view",
    "finance.manage",
    "analytics.view",
    "audit.view",
  ],
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
