import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { TenantIsolationError } from "@/lib/tenant/extension";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

// Phase 2 adversarial isolation (docs/adr/0024). Tenant A is the bootstrap
// tenant; tenant B is created per test. Every "attacker" call runs inside
// `runWithTenant(TENANT_B, …)` and must never see or touch A's rows.

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = "tenant-b";

async function seedBothTenants() {
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: "tenant-b" } });

  const custA = await prismaBase.customer.create({ data: { fullName: "A customer", tenantId: TENANT_A } });
  const custB = await prismaBase.customer.create({ data: { fullName: "B customer", tenantId: TENANT_B } });
  const orderA = await prismaBase.order.create({
    data: { customerId: custA.id, subtotal: 10, total: 10, currency: "MAD", tenantId: TENANT_A },
  });
  const orderB = await prismaBase.order.create({
    data: { customerId: custB.id, subtotal: 20, total: 20, currency: "MAD", tenantId: TENANT_B },
  });
  return { custA, custB, orderA, orderB };
}

describe("tenant isolation — reads", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("findMany only returns the active tenant's rows", async () => {
    await seedBothTenants();
    const asB = await runWithTenant(TENANT_B, "test", () => prisma.customer.findMany());
    expect(asB.map((c) => c.fullName)).toEqual(["B customer"]);
    const asA = await runWithTenant(TENANT_A, "test", () => prisma.customer.findMany());
    expect(asA.map((c) => c.fullName)).toEqual(["A customer"]);
  });

  it("findUnique cannot read another tenant's row", async () => {
    const { custA } = await seedBothTenants();
    const hit = await runWithTenant(TENANT_B, "test", () =>
      prisma.customer.findUnique({ where: { id: custA.id } })
    );
    expect(hit).toBeNull();
  });

  it("findFirst / findFirstOrThrow cannot read another tenant's row", async () => {
    const { orderA } = await seedBothTenants();
    const first = await runWithTenant(TENANT_B, "test", () =>
      prisma.order.findFirst({ where: { id: orderA.id } })
    );
    expect(first).toBeNull();
    await expect(
      runWithTenant(TENANT_B, "test", () => prisma.order.findFirstOrThrow({ where: { id: orderA.id } }))
    ).rejects.toThrow();
  });

  it("count and aggregate are scoped to the active tenant", async () => {
    await seedBothTenants();
    const count = await runWithTenant(TENANT_B, "test", () => prisma.order.count());
    expect(count).toBe(1);
    const agg = await runWithTenant(TENANT_B, "test", () => prisma.order.aggregate({ _sum: { total: true } }));
    expect(Number(agg._sum.total)).toBe(20);
  });

  it("an explicit foreign tenantId in a read filter is rejected", async () => {
    await seedBothTenants();
    await expect(
      runWithTenant(TENANT_B, "test", () =>
        prisma.customer.findMany({ where: { tenantId: TENANT_A } })
      )
    ).rejects.toThrow(TenantIsolationError);
  });
});

describe("tenant isolation — writes", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("update cannot modify another tenant's row", async () => {
    const { orderA } = await seedBothTenants();
    await expect(
      runWithTenant(TENANT_B, "test", () =>
        prisma.order.update({ where: { id: orderA.id }, data: { notes: "tampered" } })
      )
    ).rejects.toThrow();
    const fresh = await prismaBase.order.findUnique({ where: { id: orderA.id } });
    expect(fresh?.notes).toBeNull();
  });

  it("updateMany never reaches another tenant's rows", async () => {
    const { orderA } = await seedBothTenants();
    const res = await runWithTenant(TENANT_B, "test", () =>
      prisma.order.updateMany({ data: { notes: "b-only" } })
    );
    expect(res.count).toBe(1);
    const freshA = await prismaBase.order.findUnique({ where: { id: orderA.id } });
    expect(freshA?.notes).toBeNull();
  });

  it("delete cannot remove another tenant's row, but can remove its own", async () => {
    const { orderA, orderB } = await seedBothTenants();
    await expect(
      runWithTenant(TENANT_B, "test", () => prisma.order.delete({ where: { id: orderA.id } }))
    ).rejects.toThrow();
    await runWithTenant(TENANT_B, "test", () => prisma.order.delete({ where: { id: orderB.id } }));
    expect(await prismaBase.order.count()).toBe(1);
  });

  it("deleteMany never reaches another tenant's rows", async () => {
    await seedBothTenants();
    const res = await runWithTenant(TENANT_B, "test", () => prisma.order.deleteMany({}));
    expect(res.count).toBe(1);
    expect(await prismaBase.order.count()).toBe(1);
  });

  it("create stamps the active tenant even with no tenantId given", async () => {
    await seedBothTenants();
    const created = await runWithTenant(TENANT_B, "test", () =>
      prisma.customer.create({ data: { fullName: "fresh B" } })
    );
    expect(created.tenantId).toBe(TENANT_B);
  });

  it("create with an explicit foreign tenantId throws instead of writing", async () => {
    await seedBothTenants();
    await expect(
      runWithTenant(TENANT_B, "test", () =>
        prisma.customer.create({ data: { fullName: "smuggled", tenantId: TENANT_A } })
      )
    ).rejects.toThrow(TenantIsolationError);
    const aCustomers = await prismaBase.customer.findMany({ where: { tenantId: TENANT_A } });
    expect(aCustomers.map((c) => c.fullName)).toEqual(["A customer"]);
  });

  it("createMany stamps every row with the active tenant", async () => {
    await seedBothTenants();
    await runWithTenant(TENANT_B, "test", () =>
      prisma.category.createMany({
        data: [
          { name: "Cat 1", slug: `b-cat-1-${Date.now()}` },
          { name: "Cat 2", slug: `b-cat-2-${Date.now()}` },
        ],
      })
    );
    const cats = await prismaBase.category.findMany();
    expect(cats.length).toBe(2);
    expect(cats.every((c) => c.tenantId === TENANT_B)).toBe(true);
  });

  it("upsert is scoped and stamps the tenant on the create path", async () => {
    await seedBothTenants();
    const userB = await createTestUser({ tenantId: TENANT_B });
    const agent = await runWithTenant(TENANT_B, "test", () =>
      prisma.commissionAgent.upsert({
        where: { userId: userB.id },
        create: { userId: userB.id, ratePerOrder: 5 },
        update: { ratePerOrder: 9 },
      })
    );
    expect(agent.tenantId).toBe(TENANT_B);
  });
});

describe("tenant isolation — context modes", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("runUnscoped sees every tenant (used by login / webhook self-lookup)", async () => {
    await seedBothTenants();
    const all = await runUnscoped("test", () => prisma.customer.findMany());
    expect(all.map((c) => c.fullName).sort()).toEqual(["A customer", "B customer"]);
  });

  it("with no directive and no session, ops fall back to the bootstrap tenant", async () => {
    await seedBothTenants();
    const rows = await prisma.customer.findMany();
    expect(rows.map((c) => c.fullName)).toEqual(["A customer"]);
  });
});
