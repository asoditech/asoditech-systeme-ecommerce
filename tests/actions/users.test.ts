import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createUserAction, updateUserStatusAction, updateUserRoleAction } from "@/actions/users";
import { createSession } from "@/lib/auth/session";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * src/actions/users.ts is the single most privilege-sensitive surface in
 * this app (account provisioning, role changes, disable-with-session-
 * revocation) and had zero test coverage before the Phase 26 structural
 * audit. See docs/adr/0003-auth-and-rbac.md.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("users.ts — OWNER-only enforcement", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects createUserAction from a non-OWNER role", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await expect(
      createUserAction(
        formData({ name: "Nouvel employé", email: "new@test.local", password: "correct-horse-battery", role: "SALES" })
      )
    ).rejects.toThrow(/non autorisé/i);
    expect(await prisma.user.count({ where: { email: "new@test.local" } })).toBe(0);
  });

  it("rejects updateUserStatusAction from a non-OWNER role", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "SALES" });
    await expect(
      updateUserStatusAction(formData({ id: target.id, status: "DISABLED" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("rejects updateUserRoleAction from a non-OWNER role", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "SALES" });
    await expect(
      updateUserRoleAction(formData({ id: target.id, role: "MANAGER" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("an OWNER cannot disable another OWNER account", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const otherOwner = await createTestUser({ role: "OWNER" });

    const result = await updateUserStatusAction(formData({ id: otherOwner.id, status: "DISABLED" }));
    expect(result.ok).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
    expect(row.status).toBe("ACTIVE");
  });

  it("an OWNER cannot change another OWNER's role", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const otherOwner = await createTestUser({ role: "OWNER" });

    const result = await updateUserRoleAction(formData({ id: otherOwner.id, role: "SALES" }));
    expect(result.ok).toBe(false);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
    expect(row.role).toBe("OWNER");
  });
});

describe("createUserAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("creates an account with a hashed (never plaintext) password and audits it", async () => {
    const owner = await loginAsTestUser({ role: "OWNER" });

    const result = await createUserAction(
      formData({ name: "Nouvel employé", email: "new@test.local", password: "correct-horse-battery", role: "WAREHOUSE" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const created = await prisma.user.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(created.passwordHash).not.toBe("correct-horse-battery");
    expect(created.role).toBe("WAREHOUSE");

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "user.created", entityId: created.id } });
    expect(audit.actorUserId).toBe(owner.id);
  });

  it("rejects a duplicate email", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await createTestUser({ email: "taken@test.local" });

    const result = await createUserAction(
      formData({ name: "Doublon", email: "taken@test.local", password: "correct-horse-battery", role: "SALES" })
    );
    expect(result.ok).toBe(false);
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
    const target = await createTestUser({ role: "SALES" });
    // Seed two real session rows for the target — createSession() also
    // overwrites the shared mock cookie jar, so this must happen BEFORE
    // logging in as the OWNER below, or the OWNER's own action call would
    // authenticate as the target instead.
    await createSession(target.id);
    await createSession(target.id);
    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(2);

    await loginAsTestUser({ role: "OWNER" });
    const result = await updateUserStatusAction(formData({ id: target.id, status: "DISABLED" }));
    expect(result.ok).toBe(true);

    expect(await prisma.session.count({ where: { userId: target.id } })).toBe(0);
  });

  it("re-activating a user does not need to (and does not) touch sessions", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const target = await createTestUser({ role: "SALES", status: "DISABLED" });

    const result = await updateUserStatusAction(formData({ id: target.id, status: "ACTIVE" }));
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.status).toBe("ACTIVE");
  });
});
