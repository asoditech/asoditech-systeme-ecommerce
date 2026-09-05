import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { dismissNotificationAction } from "@/actions/notifications";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

describe("dismissNotificationAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("deletes the notification for its own owner", async () => {
    const user = await loginAsTestUser({ role: "WAREHOUSE" });
    const notification = await prisma.notification.create({
      data: { userId: user.id, type: "STOCK_FAIBLE", title: "Stock faible : X", message: "msg" },
    });

    const result = await dismissNotificationAction(notification.id);
    expect(result.ok).toBe(true);
    expect(await prisma.notification.findUnique({ where: { id: notification.id } })).toBeNull();
  });

  it("does not delete another user's notification", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    const other = await createTestUser({ role: "MANAGER" });
    const notification = await prisma.notification.create({
      data: { userId: other.id, type: "STOCK_FAIBLE", title: "Stock faible : X", message: "msg" },
    });

    const result = await dismissNotificationAction(notification.id);
    expect(result.ok).toBe(true); // silent no-op, not an error — matches markNotificationReadAction's own scoping
    expect(await prisma.notification.findUnique({ where: { id: notification.id } })).not.toBeNull();
  });

  it("rejects an empty id", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    const result = await dismissNotificationAction("");
    expect(result.ok).toBe(false);
  });
});
