import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import type { UserRole, UserStatus } from "@prisma/client";

let counter = 0;

/** Creates a User row with a real (hashed) password. */
export async function createTestUser(overrides: {
  role?: UserRole;
  status?: UserStatus;
  email?: string;
} = {}) {
  counter += 1;
  return prisma.user.create({
    data: {
      email: overrides.email ?? `test-user-${counter}@asoditech.test`,
      name: `Test User ${counter}`,
      passwordHash: await hashPassword("correct-horse-battery-staple"),
      role: overrides.role ?? "ADMIN",
      status: overrides.status ?? "ACTIVE",
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
