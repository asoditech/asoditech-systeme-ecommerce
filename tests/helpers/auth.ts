// Raw client on purpose: these helpers seed fixtures directly, sometimes
// into a specific (non-active) tenant, so they must bypass the scoping
// extension (docs/adr/0024).
import { prismaBase as prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { DEFAULT_TENANT_ID } from "./db";
import type { UserRole, UserStatus } from "@prisma/client";

let counter = 0;

/** Creates a User row with a real (hashed) password. */
export async function createTestUser(overrides: {
  role?: UserRole;
  status?: UserStatus;
  email?: string;
  tenantId?: string;
  isPlatformAdmin?: boolean;
} = {}) {
  counter += 1;
  return prisma.user.create({
    data: {
      email: overrides.email ?? `test-user-${counter}@asoditech.test`,
      name: `Test User ${counter}`,
      passwordHash: await hashPassword("correct-horse-battery-staple"),
      role: overrides.role ?? "ADMIN",
      status: overrides.status ?? "ACTIVE",
      tenantId: overrides.tenantId ?? DEFAULT_TENANT_ID,
      isPlatformAdmin: overrides.isPlatformAdmin ?? false,
    },
  });
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
