import type { UserRole } from "@prisma/client";
import {
  PERMISSIONS,
  PERMISSION_CHANNEL_DOMAIN,
  ROLE_PERMISSIONS,
  isPermission,
  type Permission,
} from "@/lib/auth/permissions";
import { capabilitiesForMode, permissionAvailable, type BusinessMode, type TenantCapability } from "@/lib/tenant/business-mode";

/**
 * Effective access — docs/adr/0039-permission-overrides-and-scope.md.
 *
 *   effective = ( rolePermissions ∪ GRANTs − DENYs )  filtered by channel scope
 *               … then restricted to what the tenant's BUSINESS MODE enables
 *               (docs/adr/0041): a permission whose capability is off is inert
 *               for EVERY role, OWNER/ADMIN included.
 *
 * PURE on purpose (no Prisma, no server-only): the rules live in one place
 * and are unit-testable on their own; `access-loader.ts` fetches the inputs.
 *
 *  - OWNER/ADMIN are never narrowed and never need a row: full permissions,
 *    every channel. An override or channel row targeting them is inert
 *    (lock-out protection — nobody can DENY the owner out of their own tenant).
 *  - For everyone else: start from the role baseline, add GRANTs, then remove
 *    DENYs — a DENY ALWAYS wins over a GRANT and over the role.
 *  - Channel scope is then applied to the result: a user without any ONLINE
 *    channel holds no ONLINE-domain permission, and likewise for OFFLINE.
 *    A GRANT can therefore never bypass scope.
 *  - Zero channel rows means zero channels (safe default-deny), exactly like
 *    UserLocation.
 *  - In an ONLINE_ONLY tenant NONE of the channel machinery applies: there is no
 *    Offline capability, every user is on "the" online business exactly as in the
 *    pre-channels product, and `UserChannel` rows are ignored — a missing row can
 *    never lock anyone out of orders. Offline is off for everyone.
 */

export interface ChannelAccess {
  /** OWNER/ADMIN: every channel of the tenant, no assignment rows needed. */
  global: boolean;
  /** Ids of the ACTIVE channels a non-global user is assigned to. Empty for global users (use `global`). */
  ids: readonly string[];
  onlineIds: readonly string[];
  offlineIds: readonly string[];
  /** May act on / read at least one ONLINE channel (always true for global users). */
  online: boolean;
  /** May act on / read at least one OFFLINE channel (always true for global users). */
  offline: boolean;
}

export interface EffectiveAccess {
  permissions: ReadonlySet<Permission>;
  channels: ChannelAccess;
  /** The tenant's mode and what it unlocks (docs/adr/0041). */
  businessMode: BusinessMode;
  capabilities: ReadonlySet<TenantCapability>;
}

export interface OverrideInput {
  permission: string;
  effect: "GRANT" | "DENY";
}

export interface AssignedChannelInput {
  id: string;
  kind: "ONLINE" | "OFFLINE";
  isActive: boolean;
}

export function isGlobalRole(role: UserRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export function computeEffectiveAccess(input: {
  role: UserRole;
  overrides: readonly OverrideInput[];
  assignedChannels: readonly AssignedChannelInput[];
  businessMode: BusinessMode;
}): EffectiveAccess {
  const capabilities = capabilitiesForMode(input.businessMode);
  const dual = input.businessMode === "ONLINE_AND_OFFLINE";
  const withinMode = (set: Set<Permission>) => {
    for (const permission of [...set]) if (!permissionAvailable(permission, capabilities)) set.delete(permission);
    return set;
  };

  if (isGlobalRole(input.role)) {
    return {
      permissions: withinMode(new Set<Permission>(PERMISSIONS)),
      channels: { global: true, ids: [], onlineIds: [], offlineIds: [], online: true, offline: dual },
      businessMode: input.businessMode,
      capabilities,
    };
  }

  // 1. role baseline
  const set = new Set<Permission>(ROLE_PERMISSIONS[input.role]);

  // 2. GRANTs, then DENYs — DENY always wins (applied last). An unknown or
  //    since-removed permission string is ignored, never trusted.
  for (const o of input.overrides) {
    if (o.effect === "GRANT" && isPermission(o.permission)) set.add(o.permission);
  }
  for (const o of input.overrides) {
    if (o.effect === "DENY" && isPermission(o.permission)) set.delete(o.permission);
  }

  // ONLINE_ONLY: no channel scope at all (see the header). The user simply holds
  // their role's permissions, minus whatever the mode does not enable.
  if (!dual) {
    return {
      permissions: withinMode(set),
      channels: { global: false, ids: [], onlineIds: [], offlineIds: [], online: true, offline: false },
      businessMode: input.businessMode,
      capabilities,
    };
  }

  // 3. channel scope (active channels only)
  const active = input.assignedChannels.filter((c) => c.isActive);
  const onlineIds = active.filter((c) => c.kind === "ONLINE").map((c) => c.id);
  const offlineIds = active.filter((c) => c.kind === "OFFLINE").map((c) => c.id);
  const online = onlineIds.length > 0;
  const offline = offlineIds.length > 0;

  for (const permission of [...set]) {
    const domain = PERMISSION_CHANNEL_DOMAIN[permission];
    if ((domain === "ONLINE" && !online) || (domain === "OFFLINE" && !offline)) set.delete(permission);
  }

  return {
    permissions: withinMode(set),
    channels: { global: false, ids: active.map((c) => c.id), onlineIds, offlineIds, online, offline },
    businessMode: input.businessMode,
    capabilities,
  };
}
