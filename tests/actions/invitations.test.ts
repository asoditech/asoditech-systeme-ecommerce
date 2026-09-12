import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { inviteUserAction, revokeInvitationAction, acceptInvitationAction } from "@/actions/invitations";
import { hashToken } from "@/lib/auth/tokens";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Phase 5 (docs/adr/0027-tenant-provisioning.md): user provisioning is now
 * invitation-only. Adversarial coverage focuses on the two things a broken
 * scope check would let slip: one tenant seeing/touching another tenant's
 * invitations, and an invitation resolving to the WRONG tenant's user table.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function tokenFromInviteUrl(inviteUrl: string): string {
  return inviteUrl.replace("/invitations/", "");
}

const TENANT_B = "tenant-b-invitations";

describe("inviteUserAction / revokeInvitationAction", () => {
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
    await expect(
      inviteUserAction(formData({ name: "New Person", email: "new@test.local", role: "CONFIRMATION" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("an ADMIN cannot invite a new OWNER — only OWNER may", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const result = await inviteUserAction(formData({ name: "New Owner", email: "newowner@test.local", role: "OWNER" }));
    expect(result.ok).toBe(false);
  });

  it("an OWNER can invite a new OWNER", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const result = await inviteUserAction(formData({ name: "New Owner", email: "newowner2@test.local", role: "OWNER" }));
    expect(result.ok).toBe(true);
  });

  it("rejects inviting an email that already has an account in this tenant", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await createTestUser({ email: "taken@test.local" });
    const result = await inviteUserAction(formData({ name: "Dup", email: "taken@test.local", role: "CONFIRMATION" }));
    expect(result.ok).toBe(false);
  });

  it("the SAME email can be independently invited in two different tenants", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });

    await loginAsTestUser({ role: "ADMIN" });
    const resultA = await inviteUserAction(formData({ name: "Shared", email: "shared@test.local", role: "CONFIRMATION" }));
    expect(resultA.ok).toBe(true);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN", tenantId: TENANT_B });
    const resultB = await inviteUserAction(formData({ name: "Shared", email: "shared@test.local", role: "CONFIRMATION" }));
    expect(resultB.ok).toBe(true);

    const count = await prismaBase.invitation.count({ where: { email: "shared@test.local" } });
    expect(count).toBe(2);
  });

  it("a new invitation revokes a prior PENDING one for the same email, but never another tenant's", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });

    await loginAsTestUser({ role: "ADMIN", tenantId: TENANT_B });
    const otherTenantInvite = await inviteUserAction(
      formData({ name: "Shared", email: "reinvite@test.local", role: "CONFIRMATION" })
    );
    expect(otherTenantInvite.ok).toBe(true);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    await inviteUserAction(formData({ name: "Shared", email: "reinvite@test.local", role: "CONFIRMATION" }));
    await inviteUserAction(formData({ name: "Shared", email: "reinvite@test.local", role: "CONFIRMATION" }));

    const otherTenantRow = await prismaBase.invitation.findFirst({ where: { tenantId: TENANT_B } });
    expect(otherTenantRow?.status).toBe("PENDING");

    const defaultTenantRows = await prismaBase.invitation.findMany({
      where: { tenantId: DEFAULT_TENANT_ID, email: "reinvite@test.local" },
      orderBy: { createdAt: "asc" },
    });
    expect(defaultTenantRows).toHaveLength(2);
    expect(defaultTenantRows[0]!.status).toBe("REVOKED");
    expect(defaultTenantRows[1]!.status).toBe("PENDING");
  });

  it("a tenant admin cannot revoke another tenant's invitation", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    await loginAsTestUser({ role: "ADMIN", tenantId: TENANT_B });
    const invite = await inviteUserAction(formData({ name: "B Person", email: "bperson@test.local", role: "CONFIRMATION" }));
    expect(invite.ok).toBe(true);
    const invitationId = invite.ok ? invite.data.id : "";

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    const revokeResult = await revokeInvitationAction(formData({ id: invitationId }));
    expect(revokeResult.ok).toBe(false);

    const row = await prismaBase.invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(row.status).toBe("PENDING");
  });

  it("revoking an invitation prevents it from later being accepted", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const invite = await inviteUserAction(formData({ name: "Revoke Me", email: "revokeme@test.local", role: "CONFIRMATION" }));
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    const revokeResult = await revokeInvitationAction(formData({ id: invite.data.id }));
    expect(revokeResult.ok).toBe(true);

    mockCookieStore.clear();
    const token = tokenFromInviteUrl(invite.data.inviteUrl);
    const result = await acceptInvitationAction(undefined, formData({ token, password: "correct-horse-battery-staple" }));
    expect(result).toMatchObject({ ok: false });
  });
});

describe("acceptInvitationAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("creates the user in the SAME tenant as the invitation, not the inviter's session tenant", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    await loginAsTestUser({ role: "ADMIN", tenantId: TENANT_B });
    const invite = await inviteUserAction(formData({ name: "B User", email: "buser@test.local", role: "CONFIRMATION" }));
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    mockCookieStore.clear();
    const token = tokenFromInviteUrl(invite.data.inviteUrl);
    await expect(
      acceptInvitationAction(undefined, formData({ token, password: "correct-horse-battery-staple" }))
    ).rejects.toThrow(RedirectSignal);

    const created = await prismaBase.user.findFirstOrThrow({ where: { email: "buser@test.local" } });
    expect(created.tenantId).toBe(TENANT_B);

    const invitationRow = await prismaBase.invitation.findUniqueOrThrow({ where: { id: invite.data.id } });
    expect(invitationRow.status).toBe("ACCEPTED");
    expect(invitationRow.acceptedById).toBe(created.id);
  });

  it("a token cannot be used twice", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const invite = await inviteUserAction(formData({ name: "Once", email: "once@test.local", role: "CONFIRMATION" }));
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    mockCookieStore.clear();
    const token = tokenFromInviteUrl(invite.data.inviteUrl);
    await expect(
      acceptInvitationAction(undefined, formData({ token, password: "correct-horse-battery-staple" }))
    ).rejects.toThrow(RedirectSignal);

    mockCookieStore.clear();
    const secondAttempt = await acceptInvitationAction(
      undefined,
      formData({ token, password: "another-password-1" })
    );
    expect(secondAttempt).toMatchObject({ ok: false });

    const users = await prismaBase.user.findMany({ where: { email: "once@test.local" } });
    expect(users).toHaveLength(1);
  });

  it("an expired invitation cannot be accepted", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const invite = await inviteUserAction(formData({ name: "Expired", email: "expired@test.local", role: "CONFIRMATION" }));
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    await prisma.invitation.update({ where: { id: invite.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    mockCookieStore.clear();
    const token = tokenFromInviteUrl(invite.data.inviteUrl);
    const result = await acceptInvitationAction(undefined, formData({ token, password: "correct-horse-battery-staple" }));
    expect(result).toMatchObject({ ok: false });
  });

  it("a garbage token is rejected without leaking whether it ever existed", async () => {
    const result = await acceptInvitationAction(
      undefined,
      formData({ token: "not-a-real-token", password: "correct-horse-battery-staple" })
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("a suspended tenant's invitation cannot be accepted", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    await loginAsTestUser({ role: "ADMIN", tenantId: TENANT_B });
    const invite = await inviteUserAction(formData({ name: "Suspended", email: "suspended@test.local", role: "CONFIRMATION" }));
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    await prismaBase.tenant.update({ where: { id: TENANT_B }, data: { status: "SUSPENDED" } });

    mockCookieStore.clear();
    const token = tokenFromInviteUrl(invite.data.inviteUrl);
    const result = await acceptInvitationAction(undefined, formData({ token, password: "correct-horse-battery-staple" }));
    expect(result).toMatchObject({ ok: false });
  });

  it("the stored tokenHash never equals the raw token handed to the invitee", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const invite = await inviteUserAction(formData({ name: "Hashed", email: "hashed@test.local", role: "CONFIRMATION" }));
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    const token = tokenFromInviteUrl(invite.data.inviteUrl);
    const row = await prismaBase.invitation.findUniqueOrThrow({ where: { id: invite.data.id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(hashToken(token));
  });
});

describe("Invitation acceptance — plan seat-limit enforcement (docs/adr/0035 'Limit behaviour')", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("inviteUserAction gives an early warning once the tenant's active-user count reaches the BUSINESS limit (7)", async () => {
    await loginAsTestUser({ role: "ADMIN" }); // 1 active user
    for (let i = 0; i < 6; i++) {
      await createTestUser({ status: "ACTIVE" });
    } // 1 + 6 = 7/7

    const result = await inviteUserAction(formData({ name: "Trop", email: "trop@test.local", role: "CONFIRMATION" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/forfait/i);
  });

  it("acceptInvitationAction is the authoritative check: it refuses the 8th active user even if the invitation was already created", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" }); // 1 active user
    for (let i = 0; i < 6; i++) {
      await createTestUser({ status: "ACTIVE" });
    } // 1 + 6 = 7/7 — at the limit

    // Simulate an invitation that was created before the tenant reached
    // its limit (e.g. sent moments earlier) — bypass inviteUserAction's
    // own early warning to reach acceptInvitationAction directly.
    const { generateRawToken, hashToken: hash } = await import("@/lib/auth/tokens");
    const rawToken = generateRawToken();
    await prismaBase.invitation.create({
      data: {
        email: "eighth@test.local",
        name: "Eighth",
        role: "CONFIRMATION",
        tokenHash: hash(rawToken),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        invitedById: admin.id,
      },
    });

    mockCookieStore.clear();
    const result = await acceptInvitationAction(undefined, formData({ token: rawToken, password: "correct-horse-battery-staple" }));
    expect(result).toMatchObject({ ok: false });
    if ("error" in result) expect(result.error).toMatch(/limite/i);

    expect(await prismaBase.user.count({ where: { tenantId: DEFAULT_TENANT_ID, status: "ACTIVE" } })).toBe(7);
    const noAccount = await prismaBase.user.findFirst({ where: { email: "eighth@test.local" } });
    expect(noAccount).toBeNull();
  });

  it("never lets two concurrent invitation acceptances both slip past the seat limit", async () => {
    await loginAsTestUser({ role: "ADMIN" }); // 1 active user
    for (let i = 0; i < 5; i++) {
      await createTestUser({ status: "ACTIVE" });
    } // 1 + 5 = 6/7 — exactly one seat left

    const inviteA = await inviteUserAction(formData({ name: "Race A", email: "race-a@test.local", role: "CONFIRMATION" }));
    const inviteB = await inviteUserAction(formData({ name: "Race B", email: "race-b@test.local", role: "CONFIRMATION" }));
    expect(inviteA.ok && inviteB.ok).toBe(true);
    if (!inviteA.ok || !inviteB.ok) return;

    mockCookieStore.clear();
    const tokenA = tokenFromInviteUrl(inviteA.data.inviteUrl);
    const tokenB = tokenFromInviteUrl(inviteB.data.inviteUrl);

    const results = await Promise.allSettled([
      acceptInvitationAction(undefined, formData({ token: tokenA, password: "correct-horse-battery-staple" })),
      acceptInvitationAction(undefined, formData({ token: tokenB, password: "correct-horse-battery-staple" })),
    ]);
    // Exactly one accepts (and redirects, throwing RedirectSignal); the
    // other resolves with an ok:false result (never both succeeding).
    const redirected = results.filter((r) => r.status === "rejected" && r.reason instanceof RedirectSignal);
    expect(redirected.length).toBe(1);

    expect(await prismaBase.user.count({ where: { tenantId: DEFAULT_TENANT_ID, status: "ACTIVE" } })).toBe(7);
  });
});
