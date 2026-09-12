import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";
import { resetDb, DEFAULT_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import type { UsageMetric } from "@prisma/client";

function usage(used: number, limit: number) {
  return {
    used,
    limit,
    status: used / limit >= 1 ? ("LIMIT_REACHED" as const) : used / limit >= 0.9 ? ("CRITICAL" as const) : used / limit >= 0.8 ? ("WARNING" as const) : ("NORMAL" as const),
    percent: Math.round((used / limit) * 100),
  };
}

/** Every real call site runs inside an ambient tenant context (a logged-in
 * request, or a webhook's own runWithTenant) — this wrapper mirrors that,
 * rather than relying on the bootstrap-tenant fallback the bare function
 * would otherwise fall through to for DEFAULT_TENANT_ID specifically. */
function fireAlert(metric: UsageMetric, u: ReturnType<typeof usage>) {
  return runWithTenant(DEFAULT_TENANT_ID, "test", () => checkAndNotifyUsageThreshold(DEFAULT_TENANT_ID, metric, u));
}

async function countAlertNotifications() {
  return runWithTenant(DEFAULT_TENANT_ID, "test", () =>
    prisma.notification.count({ where: { type: "USAGE_LIMIT_ALERT" } })
  );
}

describe("checkAndNotifyUsageThreshold — de-duplication (docs/adr/0035 'Alerts')", () => {
  beforeEach(async () => {
    // A recipient must exist and hold `settings.manage` for notify() to
    // fan out anything at all.
    await resetDb();
    await createTestUser({ role: "OWNER" });
  });
  afterEach(async () => {
    await resetDb();
  });

  it("does nothing below the 80% threshold", async () => {
    await fireAlert("ORDERS", usage(70, 100));
    expect(await countAlertNotifications()).toBe(0);
  });

  it("fires exactly once when crossing 80%, and does not re-fire on a repeated call at the same level (no spam on refresh)", async () => {
    await fireAlert("ORDERS", usage(82, 100));
    expect(await countAlertNotifications()).toBe(1);

    // A second call with the same (or a still-80%-bucket) usage must be a no-op.
    await fireAlert("ORDERS", usage(85, 100));
    expect(await countAlertNotifications()).toBe(1);
  });

  it("fires again when usage escalates from 80% to 90% (a genuinely higher threshold)", async () => {
    await fireAlert("ORDERS", usage(82, 100));
    expect(await countAlertNotifications()).toBe(1);

    await fireAlert("ORDERS", usage(92, 100));
    expect(await countAlertNotifications()).toBe(2);
  });

  it("fires a third time at 100% (LIMIT_REACHED)", async () => {
    await fireAlert("ORDERS", usage(82, 100));
    await fireAlert("ORDERS", usage(92, 100));
    await fireAlert("ORDERS", usage(100, 100));
    expect(await countAlertNotifications()).toBe(3);
  });

  it("does not re-fire when usage drops back below a threshold already notified, then rises again to the same one", async () => {
    await fireAlert("USERS", usage(6, 7)); // ~86%, WARNING
    expect(await countAlertNotifications()).toBe(1);

    await fireAlert("USERS", usage(5, 7)); // back under 80% — no new alert
    expect(await countAlertNotifications()).toBe(1);

    await fireAlert("USERS", usage(6, 7)); // 86% again — already notified for this period
    expect(await countAlertNotifications()).toBe(1);
  });

  it("USERS/WAREHOUSES use a period-independent 'current' bucket, ORDERS use the calendar month", async () => {
    await fireAlert("USERS", usage(6, 7));
    await fireAlert("ORDERS", usage(82, 100));

    const states = await runWithTenant(DEFAULT_TENANT_ID, "test", () => prisma.usageAlertState.findMany());
    const usersState = states.find((s) => s.metric === "USERS");
    const ordersState = states.find((s) => s.metric === "ORDERS");
    expect(usersState?.period).toBe("current");
    expect(ordersState?.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it("records an audit event alongside the notification", async () => {
    await fireAlert("WAREHOUSES", usage(3, 3));
    const events = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
      prisma.auditEvent.findMany({ where: { action: "usage.threshold_reached" } })
    );
    expect(events.length).toBe(1);
    expect(events[0].metadata).toMatchObject({ metric: "WAREHOUSES", threshold: 100 });
  });
});
