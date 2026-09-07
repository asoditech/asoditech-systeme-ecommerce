import "server-only";

import { cookies, headers } from "next/headers";
// Raw client on purpose: the extended `prisma` resolves the active tenant
// via this module, so using it here would recurse (docs/adr/0024).
import { prismaBase as prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { generateRawToken, hashToken } from "@/lib/auth/tokens";
import type { User } from "@prisma/client";

// Server-side, database-backed sessions — mirrors the Control Center's
// approach (see docs/adr/0003-auth-and-rbac.md). Only a keyed hash of the
// raw token ever touches the database or logs.

const SESSION_COOKIE = "aec_session";
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // touch at most once/day

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export async function createSession(userId: string): Promise<void> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);

  const hdrs = await headers();

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
      userAgent: hdrs.get("user-agent")?.slice(0, 255) ?? null,
      ipAddress: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ?? null,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, rawToken, cookieOptions(SESSION_DURATION_MS));
}

export async function destroyCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE)?.value;
  cookieStore.delete(SESSION_COOKIE);

  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await prisma.session.deleteMany({ where: { tokenHash } });
}

/** Revoke every session for a user — used when disabling an account, and
 * (Phase 5 — docs/adr/0027-tenant-provisioning.md) when suspending a
 * tenant (every one of its users, in one pass) or resetting a password. */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

/** Revoke every session for every user of a tenant — used when suspending
 * it (docs/adr/0027-tenant-provisioning.md): immediate lockout, not merely
 * "can't log in again". */
export async function destroyAllSessionsForTenant(tenantId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { user: { tenantId } } });
}

export type CurrentUser = Pick<User, "id" | "email" | "name" | "role" | "status" | "tenantId" | "isPlatformAdmin">;

/**
 * Resolves the authenticated user for the current request, re-verifying
 * against the database every call. Returns null if there is no valid,
 * unexpired session for an ACTIVE user in an ACTIVE tenant — a session for
 * a user whose TENANT was suspended (Phase 5) is treated exactly like a
 * disabled user's: no valid session, without needing to touch every one of
 * that tenant's session rows individually (`destroyAllSessionsForTenant`
 * still runs at suspend time for immediate, unambiguous lockout; this
 * check is the backstop for any session created in the gap).
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { include: { tenant: { select: { status: true } } } } },
  });

  if (!session || session.expiresAt < new Date()) {
    return null;
  }
  if (session.user.status !== "ACTIVE" || session.user.tenant.status !== "ACTIVE") {
    return null;
  }

  if (Date.now() - session.lastUsedAt.getTime() > SESSION_REFRESH_THRESHOLD_MS) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DURATION_MS) },
    });
  }

  const { id, email, name, role, status, tenantId, isPlatformAdmin } = session.user;
  return { id, email, name, role, status, tenantId, isPlatformAdmin };
}

export { SESSION_COOKIE };
