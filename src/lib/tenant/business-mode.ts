import type { Permission } from "@/lib/auth/permissions";

/**
 * Tenant business mode — docs/adr/0041-tenant-business-mode.md.
 *
 * PURE (no Prisma, no server-only): the whole mode → capability → permission
 * mapping lives in this one file so it is unit-testable and there is exactly
 * one place to change what a mode unlocks.
 *
 *   ONLINE_ONLY         the pre-existing product. NO Offline capability exists:
 *                       nothing of the A–G additions that is Offline-related is
 *                       visible or callable, and channels/stores affect nobody.
 *   ONLINE_AND_OFFLINE  everything ONLINE_ONLY has, plus every Offline capability.
 *
 * A "capability" is a feature family. Each capability owns (a) the permissions
 * that are inert without it and (b) the non-permission surfaces (forms, tabs,
 * actions) that check it explicitly. Enforcement is SERVER-SIDE: the effective
 * permission set drops a capability's permissions when it is off — for EVERY
 * role, OWNER/ADMIN included — so every page/Server Action/route already gated
 * on those permissions is closed by construction.
 */

export const BUSINESS_MODES = ["ONLINE_ONLY", "ONLINE_AND_OFFLINE"] as const;
export type BusinessMode = (typeof BUSINESS_MODES)[number];

export const DEFAULT_BUSINESS_MODE: BusinessMode = "ONLINE_ONLY";

export const BUSINESS_MODE_LABELS: Record<BusinessMode, string> = {
  ONLINE_ONLY: "En ligne seul",
  ONLINE_AND_OFFLINE: "En ligne + Magasin",
};

export const BUSINESS_MODE_DESCRIPTIONS: Record<BusinessMode, string> = {
  ONLINE_ONLY: "Boutique en ligne uniquement — le produit historique, sans aucune fonction magasin.",
  ONLINE_AND_OFFLINE: "Boutique en ligne et magasins physiques : ventes en magasin, achats, canaux, codes-barres, traçabilité.",
};

export const TENANT_CAPABILITIES = [
  /** In-store sales and their returns (`sales.*`), sale search, Offline dashboard KPI. */
  "offlineSales",
  /** Store channels & their administration, per-product channel availability, per-user channel assignment, the Online/Offline/Total report, store-only products. */
  "storeChannels",
  /** Suppliers, purchase receptions, supplier payments (`suppliers.*`, `purchases.*`). */
  "purchasing",
  /** Barcodes, model reference and inline category creation on products, code lookup. */
  "catalogIdentity",
  /** The product/variant traceability page (`traceability.view`). */
  "traceability",
] as const;
export type TenantCapability = (typeof TENANT_CAPABILITIES)[number];

/** What each mode unlocks. ONLINE_ONLY unlocks NOTHING — that is the whole point. */
export const MODE_CAPABILITIES: Readonly<Record<BusinessMode, readonly TenantCapability[]>> = {
  ONLINE_ONLY: [],
  ONLINE_AND_OFFLINE: [...TENANT_CAPABILITIES],
};

export function isBusinessMode(value: unknown): value is BusinessMode {
  return typeof value === "string" && (BUSINESS_MODES as readonly string[]).includes(value);
}

export function capabilitiesForMode(mode: BusinessMode): ReadonlySet<TenantCapability> {
  return new Set(MODE_CAPABILITIES[mode]);
}

/**
 * The capability a permission is inert without. A permission not listed here is
 * available in every mode. Effective permissions (effective-access.ts) drop a
 * gated permission when its capability is off — for every role.
 */
export const PERMISSION_CAPABILITY: Readonly<Partial<Record<Permission, TenantCapability>>> = {
  "sales.view": "offlineSales",
  "sales.create": "offlineSales",
  "sales.return": "offlineSales",
  "sales.override_price": "offlineSales",
  "channels.manage": "storeChannels",
  "suppliers.view": "purchasing",
  "suppliers.manage": "purchasing",
  "purchases.view": "purchasing",
  "purchases.create": "purchasing",
  "purchases.pay": "purchasing",
  "traceability.view": "traceability",
};

/** Whether a permission is usable in a tenant with these capabilities. */
export function permissionAvailable(permission: Permission, capabilities: ReadonlySet<TenantCapability>): boolean {
  const needed = PERMISSION_CAPABILITY[permission];
  return needed === undefined || capabilities.has(needed);
}
