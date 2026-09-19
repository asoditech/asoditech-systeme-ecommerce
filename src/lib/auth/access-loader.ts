import "server-only";

import type { UserRole } from "@prisma/client";
// Raw client on purpose, exactly like session.ts: this runs during session
// resolution, BEFORE the tenant is known to the extended client, and the
// extended client resolves the tenant through session.ts (docs/adr/0024) —
// using it here would recurse. Every query below is keyed on `userId`, a
// globally-unique cuid, so no cross-tenant read is possible.
import { prismaBase as prisma } from "@/lib/prisma";
import { computeEffectiveAccess, isGlobalRole, type EffectiveAccess } from "@/lib/auth/effective-access";
import { DEFAULT_BUSINESS_MODE, isBusinessMode, type BusinessMode } from "@/lib/tenant/business-mode";

/**
 * Loads the two per-user inputs of the effective computation
 * (docs/adr/0039) and computes it. OWNER/ADMIN short-circuit with ZERO extra
 * queries — nothing about them can be narrowed.
 */
export async function loadEffectiveAccess(user: {
  id: string;
  role: UserRole;
  /** The tenant's business mode — the caller (session resolution) already has it. */
  businessMode: BusinessMode;
}): Promise<EffectiveAccess> {
  if (isGlobalRole(user.role)) {
    return computeEffectiveAccess({ role: user.role, overrides: [], assignedChannels: [], businessMode: user.businessMode });
  }
  const [overrides, assignments] = await Promise.all([
    prisma.userPermissionOverride.findMany({ where: { userId: user.id }, select: { permission: true, effect: true } }),
    prisma.userChannel.findMany({
      where: { userId: user.id },
      select: { salesChannel: { select: { id: true, kind: true, isActive: true } } },
    }),
  ]);
  return computeEffectiveAccess({
    role: user.role,
    overrides,
    assignedChannels: assignments.map((a) => a.salesChannel),
    businessMode: user.businessMode,
  });
}

/**
 * Batch form for fan-out callers (notification recipients): two queries for
 * the whole list instead of two per user.
 */
export async function loadEffectiveAccessMany(
  users: readonly { id: string; role: UserRole; tenantId: string }[]
): Promise<Map<string, EffectiveAccess>> {
  const out = new Map<string, EffectiveAccess>();
  // One query for every distinct tenant's mode (in practice: one tenant).
  const tenantIds = [...new Set(users.map((u) => u.tenantId))];
  const tenants = tenantIds.length
    ? await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, businessMode: true } })
    : [];
  const modeOf = (tenantId: string): BusinessMode => {
    const m = tenants.find((t) => t.id === tenantId)?.businessMode;
    return isBusinessMode(m) ? m : DEFAULT_BUSINESS_MODE;
  };

  const scoped = users.filter((u) => !isGlobalRole(u.role));
  for (const u of users) {
    if (isGlobalRole(u.role)) {
      out.set(u.id, computeEffectiveAccess({ role: u.role, overrides: [], assignedChannels: [], businessMode: modeOf(u.tenantId) }));
    }
  }
  if (scoped.length === 0) return out;

  const ids = scoped.map((u) => u.id);
  const [overrides, assignments] = await Promise.all([
    prisma.userPermissionOverride.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, permission: true, effect: true },
    }),
    prisma.userChannel.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, salesChannel: { select: { id: true, kind: true, isActive: true } } },
    }),
  ]);
  for (const u of scoped) {
    out.set(
      u.id,
      computeEffectiveAccess({
        role: u.role,
        overrides: overrides.filter((o) => o.userId === u.id),
        assignedChannels: assignments.filter((a) => a.userId === u.id).map((a) => a.salesChannel),
        businessMode: modeOf(u.tenantId),
      })
    );
  }
  return out;
}
