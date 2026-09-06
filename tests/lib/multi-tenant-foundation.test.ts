import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

// Phase 1 multi-tenant foundation (docs/adr/0023). These prove the schema +
// migration wiring only: the bootstrap tenant exists, every scoped model
// defaults its tenantId to it with no code passing the value, and the FK is
// real. No tenant context / scoping / RLS exists yet — that is later phases.

describe("multi-tenant foundation — schema & backfill", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("the single bootstrap tenant exists after reset", async () => {
    const tenants = await prisma.tenant.findMany();
    expect(tenants).toHaveLength(1);
    expect(tenants[0]).toMatchObject({
      id: DEFAULT_TENANT_ID,
      slug: "default",
      status: "ACTIVE",
    });
  });

  it("a User created without a tenantId lands in the bootstrap tenant", async () => {
    const user = await createTestUser();
    expect(user.tenantId).toBe(DEFAULT_TENANT_ID);

    const withTenant = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { tenant: true },
    });
    expect(withTenant.tenant.id).toBe(DEFAULT_TENANT_ID);
  });

  it("defaults tenantId across a representative spread of scoped models", async () => {
    const user = await createTestUser();
    const customer = await prisma.customer.create({ data: { fullName: "Client Test" } });
    const order = await prisma.order.create({
      data: { customerId: customer.id, subtotal: 100, total: 100, currency: "MAD" },
    });
    const category = await prisma.category.create({
      data: { name: "Cat", slug: `cat-${Date.now()}` },
    });
    const warehouse = await prisma.warehouse.create({ data: { name: "WH" } });
    const settings = await prisma.businessSettings.create({ data: {} });

    for (const row of [user, customer, order, category, warehouse, settings]) {
      expect((row as { tenantId: string }).tenantId).toBe(DEFAULT_TENANT_ID);
    }
  });

  it("rejects a scoped row pointed at a non-existent tenant (FK is enforced)", async () => {
    const customer = await prisma.customer.create({ data: { fullName: "X" } });
    await expect(
      prisma.order.create({
        data: {
          customerId: customer.id,
          subtotal: 1,
          total: 1,
          currency: "MAD",
          tenantId: "does-not-exist",
        },
      })
    ).rejects.toThrow();
  });

  it("blocks deleting a tenant that still owns rows (onDelete: Restrict)", async () => {
    await createTestUser();
    await expect(
      prisma.tenant.delete({ where: { id: DEFAULT_TENANT_ID } })
    ).rejects.toThrow();
  });
});
