import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import { cleanupExpiredEphemeralData, EXPIRED_DATA_GRACE_MS } from "@/lib/maintenance/expired-data";
import { resetDb } from "../helpers/db";
import { createTestUser, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Expired-data cleanup: sessions, password reset tokens, Google OAuth states —
 * only rows expired more than the safety margin ago; active rows, in-progress
 * OAuth flows and every other table untouched; idempotent.
 */

const HOUR = 60 * 60 * 1000;
const now = new Date();
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function seedFor(userId: string, tenantId = "default") {
  const session = (expiresAt: Date) =>
    prismaBase.session.create({ data: { userId, tokenHash: uniq("s"), expiresAt } });
  const token = (expiresAt: Date, usedAt: Date | null = null) =>
    prismaBase.passwordResetToken.create({ data: { userId, tenantId, tokenHash: uniq("t"), expiresAt, usedAt } });
  const state = (expiresAt: Date) =>
    prismaBase.googleOAuthState.create({ data: { userId, tenantId, stateHash: uniq("o"), codeVerifier: "v", expiresAt } });

  return {
    sessionExpired: await session(at(-2 * HOUR)),
    sessionJustExpired: await session(at(-10 * 60 * 1000)), // within the 1h margin → kept
    sessionActive: await session(at(29 * 24 * HOUR)),
    tokenExpired: await token(at(-3 * HOUR)),
    tokenUsedAndExpired: await token(at(-3 * HOUR), at(-3.5 * HOUR)),
    tokenUsedNotExpired: await token(at(30 * 60 * 1000), at(-60 * 1000)), // consumed, kept until its own expiry
    tokenActive: await token(at(50 * 60 * 1000)),
    stateExpired: await state(at(-2 * HOUR)),
    stateInProgress: await state(at(8 * 60 * 1000)),
  };
}

const exists = {
  session: async (id: string) => (await prismaBase.session.findUnique({ where: { id } })) !== null,
  token: async (id: string) => (await prismaBase.passwordResetToken.findUnique({ where: { id } })) !== null,
  state: async (id: string) => (await prismaBase.googleOAuthState.findUnique({ where: { id } })) !== null,
};

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("cleanupExpiredEphemeralData", () => {
  it("a. removes rows expired more than the safety margin ago, in the three tables", async () => {
    const user = await createTestUser();
    const r = await seedFor(user.id);
    const res = await cleanupExpiredEphemeralData({ now });
    expect(res).toMatchObject({ sessions: 1, passwordResetTokens: 2, googleOAuthStates: 1 });
    expect(res.cutoff.getTime()).toBe(now.getTime() - EXPIRED_DATA_GRACE_MS);

    expect(await exists.session(r.sessionExpired.id)).toBe(false);
    expect(await exists.token(r.tokenExpired.id)).toBe(false);
    expect(await exists.token(r.tokenUsedAndExpired.id)).toBe(false);
    expect(await exists.state(r.stateExpired.id)).toBe(false);
  });

  it("b. active and not-yet-expired rows remain — including those expired within the margin and consumed-but-unexpired tokens", async () => {
    const user = await createTestUser();
    const r = await seedFor(user.id);
    await cleanupExpiredEphemeralData({ now });
    expect(await exists.session(r.sessionActive.id)).toBe(true);
    expect(await exists.session(r.sessionJustExpired.id)).toBe(true);
    expect(await exists.token(r.tokenActive.id)).toBe(true);
    expect(await exists.token(r.tokenUsedNotExpired.id)).toBe(true);
  });

  it("c. a valid in-progress Google OAuth state remains", async () => {
    const user = await createTestUser();
    const r = await seedFor(user.id);
    await cleanupExpiredEphemeralData({ now });
    expect(await exists.state(r.stateInProgress.id)).toBe(true);
  });

  it("d. idempotent: a second run deletes nothing and changes nothing", async () => {
    const user = await createTestUser();
    await seedFor(user.id);
    await cleanupExpiredEphemeralData({ now });
    const counts = async () => [
      await prismaBase.session.count(),
      await prismaBase.passwordResetToken.count(),
      await prismaBase.googleOAuthState.count(),
    ];
    const before = await counts();
    const again = await cleanupExpiredEphemeralData({ now });
    expect([again.sessions, again.passwordResetTokens, again.googleOAuthStates]).toEqual([0, 0, 0]);
    expect(await counts()).toEqual(before);
  });

  it("works across tenants (a maintenance task) without touching another tenant's active rows", async () => {
    const tenantB = "tenant-b-cleanup";
    await prismaBase.tenant.create({ data: { id: tenantB, name: "B", slug: tenantB } });
    const userA = await createTestUser();
    const userB = await prismaBase.user.create({
      data: { email: "b@cleanup.test", name: "B", passwordHash: "x", role: "ADMIN", tenantId: tenantB },
    });
    const a = await seedFor(userA.id);
    const b = await seedFor(userB.id, tenantB);
    await cleanupExpiredEphemeralData({ now });
    for (const r of [a, b]) {
      expect(await exists.session(r.sessionExpired.id)).toBe(false);
      expect(await exists.session(r.sessionActive.id)).toBe(true);
      expect(await exists.token(r.tokenActive.id)).toBe(true);
      expect(await exists.state(r.stateInProgress.id)).toBe(true);
    }
  });

  it("a logged-in user stays logged in after the cleanup", async () => {
    const user = await loginAsTestUser({ role: "ADMIN" });
    await seedFor(user.id);
    await cleanupExpiredEphemeralData();
    expect((await getCurrentUser())?.id).toBe(user.id);
  });

  it("touches nothing outside the three tables (expired invitation, read notification kept)", async () => {
    const user = await createTestUser();
    await prisma.invitation.create({
      data: { email: "x@cleanup.test", name: "Invité", role: "MANAGER", tokenHash: uniq("i"), expiresAt: at(-30 * 24 * HOUR), invitedById: user.id },
    });
    await prisma.notification.create({ data: { userId: user.id, type: "STOCK_FAIBLE", title: "t", message: "m", isRead: true, createdAt: at(-400 * 24 * HOUR) } });
    await cleanupExpiredEphemeralData({ now });
    expect(await prisma.invitation.count()).toBe(1);
    expect(await prisma.notification.count()).toBe(1);
  });

  it("a negative grace is treated as 0 (never deletes rows that are still valid)", async () => {
    const user = await createTestUser();
    const r = await seedFor(user.id);
    await cleanupExpiredEphemeralData({ now, graceMs: -10 * 24 * HOUR });
    expect(await exists.session(r.sessionActive.id)).toBe(true);
    expect(await exists.token(r.tokenActive.id)).toBe(true);
    expect(await exists.state(r.stateInProgress.id)).toBe(true);
  });
});
