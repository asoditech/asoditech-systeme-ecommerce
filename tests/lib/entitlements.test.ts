import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase, prismaRaw } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { computeUsageStatus, usagePercent } from "@/lib/entitlements/catalogue";
import { checkEntitlement as checkEntitlementFn, requireEntitlement, EntitlementDeniedError, withSeatLimit, PlanLimitReachedError } from "@/lib/entitlements/checks";
import { getTenantPlan, getPlanByCode, listOfferedPlans } from "@/lib/entitlements/plan";
import { resetDb, DEFAULT_TENANT_ID } from "../helpers/db";

const TENANT_B = "tenant-b-entitlements";

describe("entitlements — thresholds (docs/adr/0035 'Limit behaviour')", () => {
  it("classifies 0-79% as NORMAL, 80-89% as WARNING, 90-99% as CRITICAL, 100%+ as LIMIT_REACHED", () => {
    expect(computeUsageStatus(0, 100)).toBe("NORMAL");
    expect(computeUsageStatus(79, 100)).toBe("NORMAL");
    expect(computeUsageStatus(80, 100)).toBe("WARNING");
    expect(computeUsageStatus(89, 100)).toBe("WARNING");
    expect(computeUsageStatus(90, 100)).toBe("CRITICAL");
    expect(computeUsageStatus(99, 100)).toBe("CRITICAL");
    expect(computeUsageStatus(100, 100)).toBe("LIMIT_REACHED");
    expect(computeUsageStatus(150, 100)).toBe("LIMIT_REACHED");
  });

  it("a null limit (reserved for a future unlimited/CUSTOM plan) is always NORMAL", () => {
    expect(computeUsageStatus(1_000_000, null)).toBe("NORMAL");
    expect(usagePercent(1_000_000, null)).toBeNull();
  });

  it("usagePercent rounds to a whole percent and caps the reported value at 999", () => {
    expect(usagePercent(1184, 1500)).toBe(79);
    expect(usagePercent(9999, 100)).toBe(999);
  });
});

describe("checkEntitlement / requireEntitlement (RBAC vs entitlement split, docs/adr/0035)", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("every boolean feature and every tiered feature resolves truthy for the default BUSINESS plan", async () => {
    await expect(checkEntitlementFn(DEFAULT_TENANT_ID, "orders")).resolves.toBe(true);
    await expect(checkEntitlementFn(DEFAULT_TENANT_ID, "woocommerce")).resolves.toBe(true);
    await expect(checkEntitlementFn(DEFAULT_TENANT_ID, "shopify")).resolves.toBe(true);
    await expect(checkEntitlementFn(DEFAULT_TENANT_ID, "reports")).resolves.toBe(true);
    await expect(checkEntitlementFn(DEFAULT_TENANT_ID, "backup")).resolves.toBe(true);
  });

  it("requireEntitlement resolves silently when the feature is included, and throws EntitlementDeniedError otherwise", async () => {
    await expect(requireEntitlement(DEFAULT_TENANT_ID, "orders")).resolves.toBeUndefined();

    // Simulate a plan that genuinely lacks a feature — direct DB write
    // (there is no in-app way to make BUSINESS/PRO lack a core feature
    // today, by design; this proves the mechanism itself works). `Plan` is
    // a GLOBAL catalogue never wiped by resetDb() — the mutation MUST be
    // restored in a `finally`, or a failed assertion above would leak
    // `shopify: false` into every other test that runs afterward.
    const plan = await prismaBase.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
    const originalFeatures = plan.features;
    try {
      await prismaBase.plan.update({
        where: { id: plan.id },
        data: { features: { ...(originalFeatures as object), shopify: false } },
      });

      await expect(requireEntitlement(DEFAULT_TENANT_ID, "shopify")).rejects.toThrow(EntitlementDeniedError);
      await expect(checkEntitlementFn(DEFAULT_TENANT_ID, "shopify")).resolves.toBe(false);
    } finally {
      await prismaBase.plan.update({ where: { id: plan.id }, data: { features: originalFeatures as object } });
    }
  });
});

describe("getTenantPlan — fallback for a tenant with no subscription row", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("falls back to BUSINESS rather than throwing for a fixture tenant created without provisioning", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    // Deliberately no TenantSubscription row created for TENANT_B.
    const { plan, subscriptionStatus } = await getTenantPlan(TENANT_B);
    expect(plan.code).toBe("BUSINESS");
    expect(subscriptionStatus).toBe("ACTIVE");
  });

  it("a tenant provisioned normally (via the migration backfill / provisionTenantBaseline) has a real BUSINESS subscription", async () => {
    const { plan, currentPlanSince } = await getTenantPlan(DEFAULT_TENANT_ID);
    expect(plan.code).toBe("BUSINESS");
    expect(currentPlanSince).not.toBeNull();
  });
});

describe("listOfferedPlans / getPlanByCode — CUSTOM is never offered", () => {
  it("listOfferedPlans returns exactly BUSINESS and PRO, never CUSTOM", async () => {
    const plans = await listOfferedPlans();
    const codes = plans.map((p) => p.code).sort();
    expect(codes).toEqual(["BUSINESS", "PRO"]);
  });

  it("getPlanByCode resolves a real Plan row for BUSINESS and PRO", async () => {
    const business = await getPlanByCode("BUSINESS");
    const pro = await getPlanByCode("PRO");
    expect(business?.maxUsers).toBe(7);
    expect(business?.maxWarehouses).toBe(3);
    expect(business?.maxOrdersPerMonth).toBe(1500);
    expect(pro?.maxUsers).toBe(20);
    expect(pro?.maxWarehouses).toBe(10);
    expect(pro?.maxOrdersPerMonth).toBe(7000);
  });
});

describe("withSeatLimit — race-safe hard limit (docs/adr/0035 'Limit behaviour')", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("allows creation under the limit and rejects it once the limit is reached", async () => {
    // BUSINESS allows 3 warehouses; the bootstrap tenant already has its
    // default warehouse (1) from resetDb's own tenant upsert semantics —
    // top up to exactly the limit, then assert the next one is refused.
    const existing = await prismaBase.warehouse.count({ where: { tenantId: DEFAULT_TENANT_ID, isActive: true } });
    for (let i = existing; i < 3; i++) {
      await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        withSeatLimit(DEFAULT_TENANT_ID, "warehouses", (tx) =>
          tx.warehouse.create({ data: { name: `Entrepôt ${i}`, type: "ENTREPOT" } })
        )
      );
    }
    await expect(
      runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        withSeatLimit(DEFAULT_TENANT_ID, "warehouses", (tx) => tx.warehouse.create({ data: { name: "Un de trop", type: "ENTREPOT" } }))
      )
    ).rejects.toThrow(PlanLimitReachedError);

    // No half-applied row from the failed attempt.
    const finalCount = await prismaBase.warehouse.count({ where: { tenantId: DEFAULT_TENANT_ID, isActive: true } });
    expect(finalCount).toBe(3);
  });

  it("never lets two concurrent requests both slip past the limit (race safety)", async () => {
    // Fill to exactly one seat below the limit (2 of 3).
    const existing = await prismaBase.warehouse.count({ where: { tenantId: DEFAULT_TENANT_ID, isActive: true } });
    for (let i = existing; i < 2; i++) {
      await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        withSeatLimit(DEFAULT_TENANT_ID, "warehouses", (tx) =>
          tx.warehouse.create({ data: { name: `Entrepôt ${i}`, type: "ENTREPOT" } })
        )
      );
    }

    const attempt = () =>
      runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        withSeatLimit(DEFAULT_TENANT_ID, "warehouses", (tx) => tx.warehouse.create({ data: { name: "Concurrent", type: "ENTREPOT" } }))
      );

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const finalCount = await prismaBase.warehouse.count({ where: { tenantId: DEFAULT_TENANT_ID, isActive: true } });
    expect(finalCount).toBe(3);
  });
});

describe("tenant isolation — a tenant's plan/subscription is never visible to another tenant", () => {
  beforeEach(async () => {
    await resetDb();
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const businessPlan = await prismaBase.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
    await prismaBase.tenantSubscription.create({ data: { tenantId: TENANT_B, planId: businessPlan.id, status: "ACTIVE" } });
  });
  afterEach(async () => {
    await resetDb();
  });

  it("a raw, RLS-protected read of tenant_subscriptions with no tenant context set sees zero rows", async () => {
    const rows = await prismaRaw.tenantSubscription.findMany();
    expect(rows.length).toBe(0);
  });

  it("a scoped read for tenant A never returns tenant B's subscription row", async () => {
    const rows = await runWithTenant(DEFAULT_TENANT_ID, "test", () => prisma.tenantSubscription.findMany());
    expect(rows.every((r) => r.tenantId === DEFAULT_TENANT_ID)).toBe(true);
    expect(rows.some((r) => r.tenantId === TENANT_B)).toBe(false);
  });
});
