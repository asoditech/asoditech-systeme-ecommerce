import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getDashboardData } from "@/lib/queries/dashboard";
import { listAuditJournal } from "@/lib/queries/audit";
import { DASHBOARD_HIDDEN_AUDIT_ACTIONS, TECHNICAL_AUDIT_ACTIONS } from "@/lib/audit-classification";
import { auditActionCategory } from "@/lib/audit-labels";
import { resetDb } from "../helpers/db";

/**
 * Dashboard « Activité récente » shows business / configuration / security
 * activity; technical and routine events never crowd it out. The audit
 * journal is unchanged and still lists every event.
 */

const global = { global: true, ids: [], onlineIds: [], offlineIds: [], online: true, offline: true };

async function event(action: string, minutesAgo: number, entityType = "Order") {
  return prisma.auditEvent.create({
    data: { actorType: "SYSTEM", action, entityType, entityId: `e-${action}-${minutesAgo}`, createdAt: new Date(Date.now() - minutesAgo * 60_000) },
  });
}

beforeEach(async () => await resetDb());
afterEach(async () => await resetDb());

describe("dashboard recent activity", () => {
  it("business events stay visible even when many newer technical events exist", async () => {
    await event("order.created", 120);
    await event("stock_transfer.received", 110, "StockTransfer");
    await event("settings.updated", 100, "BusinessSettings");
    await event("user.role_changed", 90, "User");
    // 20 newer technical / routine events — enough to fill the 8 slots twice.
    const noisy = ["integration.webhook_received", "shipment.tracking_refreshed", "integration.sync_started", "integration.sync_completed", "user.login.success"];
    for (let i = 0; i < 20; i++) await event(noisy[i % noisy.length], i, "Integration");

    const data = await getDashboardData("mois");
    const actions = data.recentAuditEvents.map((e) => e.action);
    expect(actions).toEqual(["user.role_changed", "settings.updated", "stock_transfer.received", "order.created"]);
    for (const a of noisy) expect(actions).not.toContain(a);
  });

  it("every hidden action is a real, labelled audit action (no typo slips through)", () => {
    for (const a of DASHBOARD_HIDDEN_AUDIT_ACTIONS) expect(auditActionCategory(a), a).not.toBeNull();
    // Business and access-control events are never hidden.
    for (const a of ["order.created", "order.purged", "inventory.adjusted", "sale.created", "reception.validated", "user.role_changed", "user.login.failure", "settings.updated"]) {
      expect(DASHBOARD_HIDDEN_AUDIT_ACTIONS).not.toContain(a);
    }
    expect(TECHNICAL_AUDIT_ACTIONS).toContain("integration.webhook_received");
  });

  it("the full audit journal still lists every event, technical ones included", async () => {
    await event("order.created", 60);
    await event("shipment.tracking_refreshed", 30, "Shipment");
    await event("integration.sync_completed", 10, "SyncRun");
    const journal = await listAuditJournal({ channels: global }, {});
    expect(journal.total).toBe(3);
    expect(journal.items.map((i) => i.action).sort()).toEqual(["integration.sync_completed", "order.created", "shipment.tracking_refreshed"]);
  });
});
