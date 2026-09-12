import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { getTenantUsage, getUsageForAllTenants, currentPeriod } from "@/lib/entitlements/usage";
import { resetDb, DEFAULT_TENANT_ID } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

const TENANT_B = "tenant-b-usage";

async function seedOrder(placedAt: Date, tenantId = DEFAULT_TENANT_ID) {
  return runWithTenant(tenantId, "test", async () => {
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    return prisma.order.create({
      data: { customerId: customer.id, subtotal: 100, total: 100, currency: "MAD", placedAt },
    });
  });
}

describe("getTenantUsage — order counting (docs/adr/0035 'Usage metering')", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("counts every order placed in the given calendar month exactly once, regardless of status", async () => {
    const period = "2026-09";
    await seedOrder(new Date("2026-09-01T10:00:00Z"));
    await seedOrder(new Date("2026-09-15T10:00:00Z"));
    await seedOrder(new Date("2026-09-30T23:59:59Z"));

    const usage = await getTenantUsage(DEFAULT_TENANT_ID, period);
    expect(usage.orders.used).toBe(3);
  });

  it("attributes an order to the month of its placedAt, not its createdAt — a historical import never inflates the current month", async () => {
    // A backfilled/historical order dated August must count in August's
    // usage, not September's, even though the import itself (createdAt)
    // happens "now" — see docs/adr/0035's own reasoning for using
    // placedAt rather than createdAt.
    await seedOrder(new Date("2026-08-15T10:00:00Z"));
    await seedOrder(new Date("2026-09-05T10:00:00Z"));

    const august = await getTenantUsage(DEFAULT_TENANT_ID, "2026-08");
    const september = await getTenantUsage(DEFAULT_TENANT_ID, "2026-09");
    expect(august.orders.used).toBe(1);
    expect(september.orders.used).toBe(1);
  });

  it("never double-counts: a single created order is counted exactly once, and re-computing usage is idempotent", async () => {
    await seedOrder(new Date("2026-09-10T10:00:00Z"));
    const first = await getTenantUsage(DEFAULT_TENANT_ID, "2026-09");
    const second = await getTenantUsage(DEFAULT_TENANT_ID, "2026-09");
    expect(first.orders.used).toBe(1);
    expect(second.orders.used).toBe(1);
  });

  it("counts a cancelled/refunded order too — a real order that happened, regardless of what happened to it afterward", async () => {
    const order = await seedOrder(new Date("2026-09-10T10:00:00Z"));
    await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
      prisma.order.update({ where: { id: order.id }, data: { status: "ANNULEE" } })
    );
    const usage = await getTenantUsage(DEFAULT_TENANT_ID, "2026-09");
    expect(usage.orders.used).toBe(1);
  });

  it("computes the default period as the current calendar month", () => {
    const now = new Date("2026-09-15T12:00:00Z");
    expect(currentPeriod(now)).toBe("2026-09");
  });
});

describe("getTenantUsage — users & warehouses are point-in-time, active-only counts", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("counts only ACTIVE users toward the seat limit — a DISABLED account frees its seat", async () => {
    await createTestUser({ status: "ACTIVE" });
    const disabled = await createTestUser({ status: "ACTIVE" });
    const before = await getTenantUsage(DEFAULT_TENANT_ID);

    await prismaBase.user.update({ where: { id: disabled.id }, data: { status: "DISABLED" } });
    const after = await getTenantUsage(DEFAULT_TENANT_ID);

    expect(after.users.used).toBe(before.users.used - 1);
  });

  it("counts only isActive warehouses — a deactivated warehouse frees its slot", async () => {
    const before = await getTenantUsage(DEFAULT_TENANT_ID);
    const wh = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
      prisma.warehouse.create({ data: { name: "Temp", type: "ENTREPOT" } })
    );
    const middle = await getTenantUsage(DEFAULT_TENANT_ID);
    expect(middle.warehouses.used).toBe(before.warehouses.used + 1);

    await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
      prisma.warehouse.update({ where: { id: wh.id }, data: { isActive: false } })
    );
    const after = await getTenantUsage(DEFAULT_TENANT_ID);
    expect(after.warehouses.used).toBe(before.warehouses.used);
  });

  it("storage is always null — no file/object storage exists in this codebase to meter", async () => {
    const usage = await getTenantUsage(DEFAULT_TENANT_ID);
    expect(usage.storage).toBeNull();
  });
});

describe("tenant isolation — usage never leaks across tenants", () => {
  beforeEach(async () => {
    await resetDb();
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const businessPlan = await prismaBase.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
    await prismaBase.tenantSubscription.create({ data: { tenantId: TENANT_B, planId: businessPlan.id, status: "ACTIVE" } });
  });
  afterEach(async () => {
    await resetDb();
  });

  it("getTenantUsage for tenant A never counts tenant B's orders, and vice versa", async () => {
    await seedOrder(new Date("2026-09-10T10:00:00Z"), DEFAULT_TENANT_ID);
    await seedOrder(new Date("2026-09-10T10:00:00Z"), TENANT_B);
    await seedOrder(new Date("2026-09-11T10:00:00Z"), TENANT_B);

    const usageA = await getTenantUsage(DEFAULT_TENANT_ID, "2026-09");
    const usageB = await getTenantUsage(TENANT_B, "2026-09");
    expect(usageA.orders.used).toBe(1);
    expect(usageB.orders.used).toBe(2);
  });

  it("getUsageForAllTenants (the platform cross-tenant aggregate) reports each tenant's own count correctly, in one pass", async () => {
    await seedOrder(new Date("2026-09-10T10:00:00Z"), DEFAULT_TENANT_ID);
    await seedOrder(new Date("2026-09-10T10:00:00Z"), TENANT_B);
    await seedOrder(new Date("2026-09-11T10:00:00Z"), TENANT_B);

    const usageByTenant = await getUsageForAllTenants("2026-09");
    expect(usageByTenant.get(DEFAULT_TENANT_ID)?.orders).toBe(1);
    expect(usageByTenant.get(TENANT_B)?.orders).toBe(2);
  });
});

describe("performance sanity — a larger order volume is still counted correctly by one indexed query", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("correctly counts several hundred orders across two different months with no drift", async () => {
    const period = "2026-09";
    const septemberCount = 300;
    const augustCount = 120;

    await runWithTenant(DEFAULT_TENANT_ID, "test", async () => {
      const customer = await prisma.customer.create({ data: { fullName: "Client volume" } });
      const septemberOrders = Array.from({ length: septemberCount }, (_, i) => ({
        customerId: customer.id,
        subtotal: 100,
        total: 100,
        currency: "MAD",
        placedAt: new Date(Date.UTC(2026, 8, 1 + (i % 28))),
      }));
      const augustOrders = Array.from({ length: augustCount }, (_, i) => ({
        customerId: customer.id,
        subtotal: 100,
        total: 100,
        currency: "MAD",
        placedAt: new Date(Date.UTC(2026, 7, 1 + (i % 28))),
      }));
      await prisma.order.createMany({ data: [...septemberOrders, ...augustOrders] });
    });

    const start = Date.now();
    const usage = await getTenantUsage(DEFAULT_TENANT_ID, period);
    const elapsedMs = Date.now() - start;

    expect(usage.orders.used).toBe(septemberCount);
    // Generous ceiling — this asserts "a single indexed query", not a
    // strict performance budget that would make CI flaky.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
