import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { dismissNotificationAction, getNotificationSoundSyncAction } from "@/actions/notifications";
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

/** Polled by NotificationSoundListener — must stay exactly as scoped as the rest of the inbox. */
describe("getNotificationSoundSyncAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("requires an authenticated session", async () => {
    await expect(getNotificationSoundSyncAction()).rejects.toThrow();
  });

  it("returns only the caller's own notifications, never another user's", async () => {
    const me = await loginAsTestUser({ role: "WAREHOUSE" });
    const other = await createTestUser({ role: "MANAGER" });
    await prisma.notification.create({
      data: { userId: me.id, type: "STOCK_FAIBLE", title: "Mine", message: "msg" },
    });
    await prisma.notification.create({
      data: { userId: other.id, type: "STOCK_FAIBLE", title: "Not mine", message: "msg" },
    });

    const result = await getNotificationSoundSyncAction();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe("Mine");
  });

  it("never returns another tenant's notifications, even for the same userId shape", async () => {
    const me = await loginAsTestUser({ role: "WAREHOUSE" });
    await prismaBase.tenant.create({ data: { id: "other-tenant", name: "Other Tenant", slug: "other-tenant" } });
    const otherTenantUser = await createTestUser({ role: "MANAGER", tenantId: "other-tenant" });
    await prisma.notification.create({
      data: { userId: me.id, type: "STOCK_FAIBLE", title: "Mine", message: "msg" },
    });
    // A notification that happens to belong to a same-shaped user in a
    // different tenant must never leak into this poll. Created via the
    // raw client — the scoped `prisma` client correctly refuses a
    // cross-tenant write, which is itself proof isolation is enforced.
    await prismaBase.notification.create({
      data: { userId: otherTenantUser.id, tenantId: "other-tenant", type: "STOCK_FAIBLE", title: "Other tenant", message: "msg" },
    });

    const result = await getNotificationSoundSyncAction();
    expect(result.items.map((i) => i.title)).toEqual(["Mine"]);
  });

  it("caps the payload to a small limit rather than fetching the whole history", async () => {
    const me = await loginAsTestUser({ role: "WAREHOUSE" });
    for (let i = 0; i < 15; i++) {
      await prisma.notification.create({
        data: { userId: me.id, type: "STOCK_FAIBLE", title: `N${i}`, message: "msg" },
      });
    }
    const result = await getNotificationSoundSyncAction();
    expect(result.items.length).toBeLessThanOrEqual(10);
  });
});
