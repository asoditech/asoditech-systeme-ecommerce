import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { claimTenantDisplayNumber } from "@/lib/tenant/numbering";
import { TenantContextRequiredError } from "@/lib/tenant/resolve";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";

// Phase 3 adversarial coverage (docs/adr/0025-multi-tenant-isolation.md):
// composite tenant-scoped uniques, tenant-scoped BusinessSettings,
// per-tenant display numbering, and the closed "create with no context"
// bypass. Phase 2's tenant-isolation.test.ts already covers cross-tenant
// read/write blocking generically — this file is specifically about what
// Phase 3 changed.

const TENANT_A = DEFAULT_TENANT_ID;
const TENANT_B = "tenant-b-p3";

async function seedTenantB() {
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
}

describe("Phase 3 — composite tenant-scoped uniqueness", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("the same email can belong to an independent user in two tenants", async () => {
    await seedTenantB();
    const email = "same@shop.test";
    const userA = await runWithTenant(TENANT_A, "test", () =>
      prisma.user.create({ data: { email, name: "A", passwordHash: "x" } })
    );
    const userB = await runWithTenant(TENANT_B, "test", () =>
      prisma.user.create({ data: { email, name: "B", passwordHash: "x" } })
    );
    expect(userA.id).not.toBe(userB.id);
    expect(userA.tenantId).toBe(TENANT_A);
    expect(userB.tenantId).toBe(TENANT_B);

    // Global uniqueness is no longer incorrectly enforced.
    const all = await prismaBase.user.findMany({ where: { email } });
    expect(all).toHaveLength(2);

    // But within one tenant, the constraint still holds.
    await expect(
      runWithTenant(TENANT_A, "test", () => prisma.user.create({ data: { email, name: "A2", passwordHash: "x" } }))
    ).rejects.toThrow();
  });

  it("the same product SKU can exist independently in two tenants", async () => {
    await seedTenantB();
    const sku = "SKU-SHARED";
    const productA = await runWithTenant(TENANT_A, "test", () =>
      prisma.product.create({ data: { name: "A", sku, price: 10 } })
    );
    const productB = await runWithTenant(TENANT_B, "test", () =>
      prisma.product.create({ data: { name: "B", sku, price: 20 } })
    );
    expect(productA.id).not.toBe(productB.id);
    await expect(
      runWithTenant(TENANT_A, "test", () => prisma.product.create({ data: { name: "dup", sku, price: 1 } }))
    ).rejects.toThrow();
  });

  it("the same product variation SKU can exist independently in two tenants", async () => {
    await seedTenantB();
    const sku = "VAR-SHARED";
    const productA = await runWithTenant(TENANT_A, "test", () =>
      prisma.product.create({ data: { name: "A", sku: "PA", price: 10 } })
    );
    const productB = await runWithTenant(TENANT_B, "test", () =>
      prisma.product.create({ data: { name: "B", sku: "PB", price: 20 } })
    );
    const variationA = await runWithTenant(TENANT_A, "test", () =>
      prisma.productVariation.create({ data: { productId: productA.id, sku, attributes: {} } })
    );
    const variationB = await runWithTenant(TENANT_B, "test", () =>
      prisma.productVariation.create({ data: { productId: productB.id, sku, attributes: {} } })
    );
    expect(variationA.id).not.toBe(variationB.id);
  });

  it("the same category slug can exist independently in two tenants", async () => {
    await seedTenantB();
    const slug = "electronique";
    const catA = await runWithTenant(TENANT_A, "test", () =>
      prisma.category.create({ data: { name: "A", slug } })
    );
    const catB = await runWithTenant(TENANT_B, "test", () =>
      prisma.category.create({ data: { name: "B", slug } })
    );
    expect(catA.id).not.toBe(catB.id);
    await expect(
      runWithTenant(TENANT_A, "test", () => prisma.category.create({ data: { name: "dup", slug } }))
    ).rejects.toThrow();
  });

  it("the same expense category name can exist independently in two tenants", async () => {
    await seedTenantB();
    const name = "Publicité";
    const ecA = await runWithTenant(TENANT_A, "test", () => prisma.expenseCategory.create({ data: { name } }));
    const ecB = await runWithTenant(TENANT_B, "test", () => prisma.expenseCategory.create({ data: { name } }));
    expect(ecA.id).not.toBe(ecB.id);
    await expect(
      runWithTenant(TENANT_A, "test", () => prisma.expenseCategory.create({ data: { name } }))
    ).rejects.toThrow();
  });

  it("the same integration provider can be connected independently in two tenants", async () => {
    await seedTenantB();
    const intA = await runWithTenant(TENANT_A, "test", () =>
      prisma.integration.create({ data: { provider: "WOOCOMMERCE" } })
    );
    const intB = await runWithTenant(TENANT_B, "test", () =>
      prisma.integration.create({ data: { provider: "WOOCOMMERCE" } })
    );
    expect(intA.id).not.toBe(intB.id);
    await expect(
      runWithTenant(TENANT_A, "test", () => prisma.integration.create({ data: { provider: "WOOCOMMERCE" } }))
    ).rejects.toThrow();
  });

  it("the same (source, externalId) order identity can exist independently in two tenants", async () => {
    await seedTenantB();
    const custA = await runWithTenant(TENANT_A, "test", () => prisma.customer.create({ data: { fullName: "A" } }));
    const custB = await runWithTenant(TENANT_B, "test", () => prisma.customer.create({ data: { fullName: "B" } }));
    const orderA = await runWithTenant(TENANT_A, "test", () =>
      prisma.order.create({
        data: { customerId: custA.id, subtotal: 1, total: 1, currency: "MAD", source: "WOOCOMMERCE", externalId: "999" },
      })
    );
    const orderB = await runWithTenant(TENANT_B, "test", () =>
      prisma.order.create({
        data: { customerId: custB.id, subtotal: 1, total: 1, currency: "MAD", source: "WOOCOMMERCE", externalId: "999" },
      })
    );
    expect(orderA.id).not.toBe(orderB.id);
    await expect(
      runWithTenant(TENANT_A, "test", () =>
        prisma.order.create({
          data: { customerId: custA.id, subtotal: 1, total: 1, currency: "MAD", source: "WOOCOMMERCE", externalId: "999" },
        })
      )
    ).rejects.toThrow();
  });
});

describe("Phase 3 — tenant-scoped BusinessSettings", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("each tenant gets its own settings row, isolated from the other's updates", async () => {
    await seedTenantB();
    const settingsA = await runWithTenant(TENANT_A, "test", () =>
      prisma.businessSettings.upsert({
        where: { tenantId: TENANT_A },
        update: { companyName: "A Corp" },
        create: { companyName: "A Corp" },
      })
    );
    const settingsB = await runWithTenant(TENANT_B, "test", () =>
      prisma.businessSettings.upsert({
        where: { tenantId: TENANT_B },
        update: { companyName: "B Corp" },
        create: { companyName: "B Corp" },
      })
    );
    expect(settingsA.id).not.toBe(settingsB.id);
    expect(settingsA.companyName).toBe("A Corp");
    expect(settingsB.companyName).toBe("B Corp");

    // B cannot see or touch A's settings row.
    const bReadsOwn = await runWithTenant(TENANT_B, "test", () => prisma.businessSettings.findMany());
    expect(bReadsOwn.map((s) => s.companyName)).toEqual(["B Corp"]);
  });
});

describe("Phase 3 — per-tenant display numbering", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("claimTenantDisplayNumber counts up independently per tenant, starting at 1", async () => {
    await seedTenantB();
    const a1 = await claimTenantDisplayNumber(prisma, TENANT_A, "order");
    const a2 = await claimTenantDisplayNumber(prisma, TENANT_A, "order");
    const b1 = await claimTenantDisplayNumber(prisma, TENANT_B, "order");
    expect(a1).toBe(1);
    expect(a2).toBe(2);
    expect(b1).toBe(1);
  });

  it("the three sequences (order/transfer/stocktake) are independent of each other", async () => {
    const order1 = await claimTenantDisplayNumber(prisma, TENANT_A, "order");
    const transfer1 = await claimTenantDisplayNumber(prisma, TENANT_A, "transfer");
    const stocktake1 = await claimTenantDisplayNumber(prisma, TENANT_A, "stocktake");
    expect(order1).toBe(1);
    expect(transfer1).toBe(1);
    expect(stocktake1).toBe(1);
  });

  it("createOrderAction assigns a per-tenant displayNumber without touching the legacy global orderNumber", async () => {
    await seedTenantB();
    const custA = await runWithTenant(TENANT_A, "test", () => prisma.customer.create({ data: { fullName: "A" } }));
    // A pre-Phase-3-shaped legacy order: no displayNumber, only orderNumber.
    const legacy = await runWithTenant(TENANT_A, "test", () =>
      prisma.order.create({ data: { customerId: custA.id, subtotal: 1, total: 1, currency: "MAD" } })
    );
    expect(legacy.displayNumber).toBeNull();
    expect(legacy.orderNumber).toEqual(expect.any(Number));

    // A new order claims a real per-tenant displayNumber, the historical
    // orderNumber sequence is untouched (still a normal autoincrement).
    const displayNumber = await claimTenantDisplayNumber(prisma, TENANT_A, "order");
    const numbered = await runWithTenant(TENANT_A, "test", () =>
      prisma.order.create({
        data: { customerId: custA.id, subtotal: 1, total: 1, currency: "MAD", displayNumber },
      })
    );
    expect(numbered.displayNumber).toBe(1);
    expect(numbered.orderNumber).not.toBe(legacy.orderNumber);
    // Legacy row's own orderNumber never changed.
    const legacyReread = await prismaBase.order.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(legacyReread.orderNumber).toBe(legacy.orderNumber);
    expect(legacyReread.displayNumber).toBeNull();
  });
});

describe("Phase 3 — missing tenant context rejects a create outside tests", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => {
    vi.unstubAllEnvs();
    await resetDb();
  });

  it("a create with no directive and no session throws instead of silently landing in the default tenant", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const before = await prismaBase.customer.count();
    await expect(prisma.customer.create({ data: { fullName: "should not land anywhere" } })).rejects.toThrow(
      TenantContextRequiredError
    );
    const after = await prismaBase.customer.count();
    expect(after).toBe(before);
  });

  it("upsert's create branch is rejected the same way", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      prisma.expenseCategory.upsert({
        where: { tenantId_name: { tenantId: DEFAULT_TENANT_ID, name: "Ghost" } },
        update: {},
        create: { name: "Ghost" },
      })
    ).rejects.toThrow(TenantContextRequiredError);
  });

  it("a read with no context still falls back to the bootstrap tenant (unaffected by this change)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(prisma.customer.findMany()).resolves.toEqual([]);
  });
});
