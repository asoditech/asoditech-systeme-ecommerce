import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import {
  requestPasswordResetAction,
  resetPasswordAction,
  adminResetPasswordAction,
} from "@/actions/password-reset";
import { createSession } from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { hashToken } from "@/lib/auth/tokens";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Phase 5 (docs/adr/0027-tenant-provisioning.md). Password reset shares the
 * same tenant-ambiguity as login (docs/adr/0025 — email unique per tenant,
 * not globally): the adversarial cases here mirror auth.test.ts's
 * "shared email across tenants" coverage, plus the admin-initiated path's
 * own-tenant scoping.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function tokenFromResetUrl(resetUrl: string): string {
  return resetUrl.replace("/reinitialiser-mot-de-passe/", "");
}

const TENANT_B = "tenant-b-password-reset";

describe("requestPasswordResetAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("issues a token for a matching ACTIVE user and always returns a generic success", async () => {
    const user = await createTestUser({ email: "resetme@test.local" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await requestPasswordResetAction(undefined, formData({ email: "resetme@test.local" }));
    expect(result.ok).toBe(true);

    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("returns the identical response for a non-existent email (no enumeration)", async () => {
    const knownEmailResult = await requestPasswordResetAction(undefined, formData({ email: "unknown@test.local" }));
    const known = await createTestUser({ email: "known2@test.local" });
    const secondResult = await requestPasswordResetAction(undefined, formData({ email: "known2@test.local" }));

    expect(knownEmailResult).toMatchObject({ ok: true });
    expect(secondResult).toMatchObject({ ok: true });
    expect(knownEmailResult).toEqual(secondResult);
    expect(known.email).toBe("known2@test.local");
  });

  it("issues an INDEPENDENT token per tenant when the same email exists in two tenants", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const userA = await createTestUser({ email: "shared@test.local", tenantId: DEFAULT_TENANT_ID });
    const userB = await createTestUser({ email: "shared@test.local", tenantId: TENANT_B });

    await requestPasswordResetAction(undefined, formData({ email: "shared@test.local" }));

    const tokenA = await prismaBase.passwordResetToken.findFirst({ where: { userId: userA.id } });
    const tokenB = await prismaBase.passwordResetToken.findFirst({ where: { userId: userB.id } });
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenA!.tokenHash).not.toBe(tokenB!.tokenHash);
    expect(tokenA!.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(tokenB!.tenantId).toBe(TENANT_B);
  });

  it("does not issue a token for a DISABLED account", async () => {
    const user = await createTestUser({ email: "disabled-reset@test.local", status: "DISABLED" });
    await requestPasswordResetAction(undefined, formData({ email: "disabled-reset@test.local" }));
    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(0);
  });

  it("does not issue a token for a user in a SUSPENDED tenant", async () => {
    await prismaBase.tenant.create({
      data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B, status: "SUSPENDED" },
    });
    const user = await createTestUser({ email: "suspended-tenant@test.local", tenantId: TENANT_B });
    await requestPasswordResetAction(undefined, formData({ email: "suspended-tenant@test.local" }));
    const tokens = await prismaBase.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens).toHaveLength(0);
  });
});

describe("resetPasswordAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  async function requestReset(email: string) {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await requestPasswordResetAction(undefined, formData({ email }));
    const call = logSpy.mock.calls.find((args) => String(args[0]).includes("link="));
    logSpy.mockRestore();
    const link = String(call?.[0] ?? "");
    const match = link.match(/link=(\/reinitialiser-mot-de-passe\/\S+)/);
    if (!match) throw new Error("no reset link logged");
    return tokenFromResetUrl(match[1]!);
  }

  it("resets the password, invalidates the token, and destroys existing sessions", async () => {
    const user = await createTestUser({ email: "changeme@test.local" });
    await createSession(user.id);
    await createSession(user.id);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);

    const token = await requestReset("changeme@test.local");

    await expect(
      resetPasswordAction(undefined, formData({ token, password: "brand-new-password-1" }))
    ).rejects.toThrow(RedirectSignal);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword("brand-new-password-1", row.passwordHash)).toBe(true);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    const usedToken = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect(usedToken.usedAt).not.toBeNull();
  });

  it("a token cannot be used twice", async () => {
    await createTestUser({ email: "onceonly@test.local" });
    const token = await requestReset("onceonly@test.local");

    await expect(
      resetPasswordAction(undefined, formData({ token, password: "first-new-password" }))
    ).rejects.toThrow(RedirectSignal);

    const second = await resetPasswordAction(undefined, formData({ token, password: "second-new-password" }));
    expect(second).toMatchObject({ ok: false });
  });

  it("an expired token is rejected", async () => {
    await createTestUser({ email: "expiredreset@test.local" });
    const token = await requestReset("expiredreset@test.local");
    await prisma.passwordResetToken.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await resetPasswordAction(undefined, formData({ token, password: "brand-new-password-2" }));
    expect(result).toMatchObject({ ok: false });
  });

  it("a token minted for tenant A cannot reset a same-email user in tenant B", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const userA = await createTestUser({ email: "cross@test.local", tenantId: DEFAULT_TENANT_ID });
    const userB = await createTestUser({ email: "cross@test.local", tenantId: TENANT_B });

    const token = await requestReset("cross@test.local");
    const resetToken = await prismaBase.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect([userA.id, userB.id]).toContain(resetToken.userId);

    await expect(
      resetPasswordAction(undefined, formData({ token, password: "brand-new-password-3" }))
    ).rejects.toThrow(RedirectSignal);

    const untouchedId = resetToken.userId === userA.id ? userB.id : userA.id;
    const untouched = await prismaBase.user.findUniqueOrThrow({ where: { id: untouchedId } });
    expect(await verifyPassword("brand-new-password-3", untouched.passwordHash)).toBe(false);
  });
});

describe("adminResetPasswordAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without users.manage", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const target = await createTestUser({ role: "CONFIRMATION" });
    await expect(adminResetPasswordAction(formData({ userId: target.id }))).rejects.toThrow(/non autorisé/i);
  });

  it("an ADMIN cannot generate a reset link for a user in ANOTHER tenant", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const targetInB = await createTestUser({ role: "CONFIRMATION", tenantId: TENANT_B });

    await loginAsTestUser({ role: "ADMIN" });
    const result = await adminResetPasswordAction(formData({ userId: targetInB.id }));
    expect(result.ok).toBe(false);

    const tokens = await prismaBase.passwordResetToken.findMany({ where: { userId: targetInB.id } });
    expect(tokens).toHaveLength(0);
  });

  it("returns a usable reset link for a user in the admin's own tenant", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION" });

    const result = await adminResetPasswordAction(formData({ userId: target.id }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    mockCookieStore.clear();
    const token = tokenFromResetUrl(result.data.resetUrl);
    await expect(
      resetPasswordAction(undefined, formData({ token, password: "admin-issued-password" }))
    ).rejects.toThrow(RedirectSignal);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(await verifyPassword("admin-issued-password", row.passwordHash)).toBe(true);
  });
});
