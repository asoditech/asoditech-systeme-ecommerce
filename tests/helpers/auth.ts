// Raw client on purpose: these helpers seed fixtures directly, sometimes
// into a specific (non-active) tenant, so they must bypass the scoping
// extension (docs/adr/0024).
import { prismaBase as prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { DEFAULT_TENANT_ID } from "./db";
import type { UserRole, UserStatus } from "@prisma/client";

let counter = 0;

/** The tenant's default ONLINE channel (created on demand) — raw client, tenant given explicitly. */
export async function ensureDefaultOnlineChannelFor(tenantId: string = DEFAULT_TENANT_ID) {
  const existing = await prisma.salesChannel.findFirst({ where: { tenantId, isDefault: true } });
  if (existing) return existing;
  return prisma.salesChannel.create({ data: { tenantId, name: "En ligne", kind: "ONLINE", isDefault: true } });
}

/**
 * Online/Offline unification (docs/adr/0038, 0039): channel scope is the
 * channel counterpart of `grantLocationAccess`. OWNER/ADMIN never need it.
 */
export async function grantChannelAccess(userId: string, channelIds: string | string[]) {
  const ids = Array.isArray(channelIds) ? channelIds : [channelIds];
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
  await prisma.userChannel.createMany({
    data: ids.map((salesChannelId) => ({ userId, salesChannelId, tenantId: user.tenantId })),
    skipDuplicates: true,
  });
}

/**
 * Creates a User row with a real (hashed) password.
 *
 * A non-OWNER/non-ADMIN user is granted the tenant's default ONLINE channel —
 * exactly what the channels migration backfilled for every pre-existing user
 * (they could already work the delivery business), so the whole pre-existing
 * suite keeps exercising the AUTHORIZED path unchanged. Pass
 * `channels: "none"` to create a user with ZERO channels (default-deny), and
 * assign channels explicitly with `grantChannelAccess`.
 */
export async function createTestUser(overrides: {
  role?: UserRole;
  status?: UserStatus;
  email?: string;
  tenantId?: string;
  isPlatformAdmin?: boolean;
  channels?: "default-online" | "none";
} = {}) {
  counter += 1;
  const tenantId = overrides.tenantId ?? DEFAULT_TENANT_ID;
  const role = overrides.role ?? "ADMIN";
  const user = await prisma.user.create({
    data: {
      email: overrides.email ?? `test-user-${counter}@asoditech.test`,
      name: `Test User ${counter}`,
      passwordHash: await hashPassword("correct-horse-battery-staple"),
      role,
      status: overrides.status ?? "ACTIVE",
      tenantId,
      isPlatformAdmin: overrides.isPlatformAdmin ?? false,
    },
  });
  if (role !== "OWNER" && role !== "ADMIN" && (overrides.channels ?? "default-online") === "default-online") {
    const channel = await ensureDefaultOnlineChannelFor(tenantId);
    await prisma.userChannel.create({ data: { userId: user.id, salesChannelId: channel.id, tenantId } });
  }
  return user;
}

/**
 * Creates a user and establishes a session for them via the real
 * createSession() implementation — this sets the shared mock cookie jar
 * (tests/mocks/cookie-store.ts), so any subsequent call to
 * getCurrentUser()/requireUserForAction() in the same test resolves to
 * this user, exactly as it would for a real logged-in browser session.
 */
export async function loginAsTestUser(overrides: Parameters<typeof createTestUser>[0] = {}) {
  const user = await createTestUser(overrides);
  await createSession(user.id);
  return user;
}

/**
 * Location Access Management v1 (docs/adr/0037): grants a (non-OWNER/
 * non-ADMIN) test user access to one or more warehouses — the exact
 * fixture equivalent of an admin using the "Emplacements" dialog. OWNER/
 * ADMIN never need this (global access by role); calling it for one is
 * harmless (the row is simply never consulted) but pointless.
 */
export async function grantLocationAccess(userId: string, warehouseIds: string | string[]) {
  const ids = Array.isArray(warehouseIds) ? warehouseIds : [warehouseIds];
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
  await prisma.userLocation.createMany({
    data: ids.map((warehouseId) => ({ userId, warehouseId, tenantId: user.tenantId })),
    skipDuplicates: true,
  });
}
