import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { loginAction } from "@/actions/auth";
import { getCurrentUser } from "@/lib/auth/session";
import { resetDb } from "../helpers/db";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("loginAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("establishes a session and redirects on correct credentials", async () => {
    await prisma.user.create({
      data: {
        email: "owner@test.local",
        name: "Owner",
        passwordHash: await hashPassword("correct-horse-battery-staple"),
        role: "OWNER",
        status: "ACTIVE",
      },
    });

    await expect(
      loginAction(undefined, formData({ email: "owner@test.local", password: "correct-horse-battery-staple" }))
    ).rejects.toThrow(RedirectSignal);

    const user = await getCurrentUser();
    expect(user?.email).toBe("owner@test.local");
  });

  it("returns the identical error for a wrong password and a non-existent account (no enumeration)", async () => {
    await prisma.user.create({
      data: {
        email: "owner@test.local",
        name: "Owner",
        passwordHash: await hashPassword("correct-horse-battery-staple"),
        role: "OWNER",
        status: "ACTIVE",
      },
    });

    const wrongPassword = await loginAction(undefined, formData({ email: "owner@test.local", password: "wrong" }));
    const noSuchAccount = await loginAction(undefined, formData({ email: "nobody@test.local", password: "wrong" }));

    expect(wrongPassword).toMatchObject({ ok: false });
    expect(noSuchAccount).toMatchObject({ ok: false });
    if (!wrongPassword.ok && !noSuchAccount.ok) {
      expect(wrongPassword.error).toBe(noSuchAccount.error);
    }
  });

  it("rejects login for a DISABLED account", async () => {
    await prisma.user.create({
      data: {
        email: "disabled@test.local",
        name: "Disabled",
        passwordHash: await hashPassword("correct-horse-battery-staple"),
        role: "SALES",
        status: "DISABLED",
      },
    });

    const result = await loginAction(
      undefined,
      formData({ email: "disabled@test.local", password: "correct-horse-battery-staple" })
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("records an audit event for both success and failure", async () => {
    await prisma.user.create({
      data: {
        email: "owner@test.local",
        name: "Owner",
        passwordHash: await hashPassword("correct-horse-battery-staple"),
        role: "OWNER",
        status: "ACTIVE",
      },
    });

    await loginAction(undefined, formData({ email: "owner@test.local", password: "wrong" })).catch(() => {});
    const failureEvent = await prisma.auditEvent.findFirst({ where: { action: "user.login.failure" } });
    expect(failureEvent).toBeTruthy();

    await expect(
      loginAction(undefined, formData({ email: "owner@test.local", password: "correct-horse-battery-staple" }))
    ).rejects.toThrow(RedirectSignal);
    const successEvent = await prisma.auditEvent.findFirst({ where: { action: "user.login.success" } });
    expect(successEvent).toBeTruthy();
  });
});
