import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateUserStatusAction, updateUserRoleAction, deleteUserAction } from "@/actions/users";
import { createSession } from "@/lib/auth/session";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * src/actions/users.ts is the single most privilege-sensitive surface in
 * this app (role changes, disable-with-session-revocation) and had zero
 * test coverage before the Phase 26 structural audit. See
 * docs/adr/0003-auth-and-rbac.md and docs/adr/0027-tenant-provisioning.md
 * (Phase 5 — OWNER and ADMIN, not OWNER-only, may manage users; account
 * provisioning itself is now `inviteUserAction`, see
 * tests/actions/invitations.test.ts).
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("users.ts — users.manage enforcement (OWNER + ADMIN)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects updateUserStatusAction from a role without users.manage", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const target = await createTestUser({ role: "CONFIRMATION" });
    await expect(
      updateUserStatusAction(formData({ id: target.id, status: "DISABLED" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("rejects updateUserRoleAction from a role without users.manage", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const target = await createTestUser({ role: "CONFIRMATION" });
    await expect(
      updateUserRoleAction(formData({ id: target.id, role: "MANAGER" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("an ADMIN (not just OWNER) can disable a user in their own tenant", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION" });

    const result = await updateUserStatusAction(formData({ id: target.id, status: "DISABLED" }));
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe("DISABLED");
  });

  it("an ADMIN can change a non-OWNER user's role", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION" });

    const result = await updateUserRoleAction(formData({ id: target.id, role: "MANAGER" }));
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.role).toBe("MANAGER");
  });

  it("an ADMIN cannot promote a user to OWNER — only OWNER may", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION" });

    const result = await updateUserRoleAction(formData({ id: target.id, role: "OWNER" }));
    expect(result.ok).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.role).toBe("CONFIRMATION");
  });

  it("an OWNER may promote a user to OWNER", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const target = await createTestUser({ role: "ADMIN" });

    const result = await updateUserRoleAction(formData({ id: target.id, role: "OWNER" }));
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.role).toBe("OWNER");
  });

  it("no one — not even OWNER — can disable another OWNER account", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const otherOwner = await createTestUser({ role: "OWNER" });

    const result = await updateUserStatusAction(formData({ id: otherOwner.id, status: "DISABLED" }));
    expect(result.ok).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
    expect(row.status).toBe("ACTIVE");
  });

  it("no one — not even OWNER — can change another OWNER's role", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const otherOwner = await createTestUser({ role: "OWNER" });

    const result = await updateUserRoleAction(formData({ id: otherOwner.id, role: "CONFIRMATION" }));
    expect(result.ok).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
    expect(row.role).toBe("OWNER");
  });
});

describe("deleteUserAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects deleteUserAction from a role without users.manage", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const target = await createTestUser({ role: "CONFIRMATION" });
    await expect(
      deleteUserAction(formData({ id: target.id, confirmEmail: target.email }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("deletes the account and cascades its own dependent rows, but preserves records it created", async () => {
    const target = await createTestUser({ role: "CONFIRMATION" });
    await createSession(target.id);
    const customer = await prisma.customer.create({
      data: { fullName: "Client X", createdById: target.id },
    });

    await loginAsTestUser({ role: "ADMIN" });
    const result = await deleteUserAction(formData({ id: target.id, confirmEmail: target.email }));
    expect(result.ok).toBe(true);

    expect(await prisma.user.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
    const survivingCustomer = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(survivingCustomer.createdById).toBeNull();
  });

  it("refuses when the typed e-mail confirmation does not match", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION" });

    const result = await deleteUserAction(formData({ id: target.id, confirmEmail: "wrong@asoditech.test" }));
    expect(result.ok).toBe(false);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });

  it("cannot delete the OWNER, and cannot delete yourself", async () => {
    const me = await loginAsTestUser({ role: "OWNER" });
    const owner = await createTestUser({ role: "OWNER" });

    expect((await deleteUserAction(formData({ id: owner.id, confirmEmail: owner.email }))).ok).toBe(false);
    expect((await deleteUserAction(formData({ id: me.id, confirmEmail: me.email }))).ok).toBe(false);
    expect(await prisma.user.findUnique({ where: { id: owner.id } })).not.toBeNull();
    expect(await prisma.user.findUnique({ where: { id: me.id } })).not.toBeNull();
  });

  it("refuses to delete a commission agent that already has ledger entries", async () => {
    const target = await createTestUser({ role: "CONFIRMATION" });
    const agent = await prisma.commissionAgent.create({
      data: { userId: target.id, ratePerOrder: 10 },
    });
    const customer = await prisma.customer.create({ data: { fullName: "Client Y" } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, status: "LIVREE", subtotal: 100, total: 100, currency: "MAD" },
    });
    await prisma.commissionEntry.create({
      data: { agentId: agent.id, orderId: order.id, type: "EARNED", amount: 10, rateApplied: 10 },
    });

    await loginAsTestUser({ role: "ADMIN" });
    const result = await deleteUserAction(formData({ id: target.id, confirmEmail: target.email }));
    expect(result.ok).toBe(false);
    expect(await prisma.user.findUnique({ where: { id: target.id } })).not.toBeNull();
  });
});

describe("updateUserStatusAction — session revocation", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("disabling a user destroys every one of their sessions", async () => {
    const target = await createTestUser({ role: "CONFIRMATION" });
    // Seed two real session rows for the target — createSession() also
    // overwrites the shared mock cookie jar, so this must happen BEFORE
    // logging in as the ADMIN below, or the ADMIN's own action call would
    // authenticate as the target instead.
    await createSession(target.id);
    await createSession(target.id);
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(2);

    await loginAsTestUser({ role: "ADMIN" });
    const result = await updateUserStatusAction(formData({ id: target.id, status: "DISABLED" }));
    expect(result.ok).toBe(true);

    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
  });

  it("re-activating a user does not need to (and does not) touch sessions", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION", status: "DISABLED" });

    const result = await updateUserStatusAction(formData({ id: target.id, status: "ACTIVE" }));
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe("ACTIVE");
  });
});
