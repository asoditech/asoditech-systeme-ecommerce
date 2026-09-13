import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import {
  changeTenantPlanAction,
  updateSubscriptionStatusAction,
  previewTenantPlanChange,
  updatePlanAction,
  requestPlanUpgradeAction,
} from "@/actions/plans";
import { getTenantPlan, listAllPlans, listOfferedPlans } from "@/lib/entitlements/plan";
import { resetDb, DEFAULT_TENANT_ID } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

const TENANT_B = "tenant-b-plans";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function seedTenantB() {
  await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
  const businessPlan = await prismaBase.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
  await prismaBase.tenantSubscription.create({ data: { tenantId: TENANT_B, planId: businessPlan.id, status: "ACTIVE" } });
}

describe("Platform plan/subscription administration (docs/adr/0035 'Platform plan control')", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  describe("authorization — a normal tenant admin cannot touch platform plan controls", () => {
    it("rejects a plain OWNER (not a platform admin) for every platform plan action", async () => {
      await loginAsTestUser({ role: "OWNER", isPlatformAdmin: false });

      await expect(changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "PRO" }))).rejects.toThrow(/non autorisé/i);
      await expect(updateSubscriptionStatusAction(formData({ tenantId: DEFAULT_TENANT_ID, status: "PAST_DUE" }))).rejects.toThrow(/non autorisé/i);
      await expect(previewTenantPlanChange(DEFAULT_TENANT_ID, "PRO")).rejects.toThrow(/non autorisé/i);

      const plan = await prismaBase.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
      await expect(
        updatePlanAction(
          formData({
            planId: plan.id,
            name: "Business",
            installationPriceMad: "1500",
            monthlyPriceMad: "599",
            maxOrdersPerMonth: "1500",
            maxUsers: "7",
            maxWarehouses: "3",
            features: JSON.stringify(plan.features),
          })
        )
      ).rejects.toThrow(/non autorisé/i);
    });

    it("a client cannot modify its own limits: an ADMIN (settings.manage) cannot reach any platform plan action either", async () => {
      await loginAsTestUser({ role: "ADMIN", isPlatformAdmin: false });
      await expect(changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "PRO" }))).rejects.toThrow(/non autorisé/i);
    });
  });

  describe("changeTenantPlanAction", () => {
    it("a platform admin can change a tenant's plan, and it is audited with the correct tenant/actor", async () => {
      const admin = await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });

      const result = await changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "PRO" }));
      expect(result.ok).toBe(true);

      const { plan } = await getTenantPlan(DEFAULT_TENANT_ID);
      expect(plan.code).toBe("PRO");

      const events = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        prisma.auditEvent.findMany({ where: { action: "plan.changed", entityType: "TenantSubscription" } })
      );
      expect(events.length).toBe(1);
      expect(events[0].actorUserId).toBe(admin.id);
      expect(events[0].previousValue).toMatchObject({ planCode: "BUSINESS" });
      expect(events[0].newValue).toMatchObject({ planCode: "PRO" });
    });

    it("platform plan changes are tenant-scoped: changing tenant A's plan never touches tenant B's", async () => {
      await seedTenantB();
      await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });

      await changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "PRO" }));

      const { plan: planA } = await getTenantPlan(DEFAULT_TENANT_ID);
      const { plan: planB } = await getTenantPlan(TENANT_B);
      expect(planA.code).toBe("PRO");
      expect(planB.code).toBe("BUSINESS");
    });

    it("downgrading a tenant currently over the new plan's limits succeeds and deletes nothing", async () => {
      await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
      await changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "PRO" }));

      // Create more users than BUSINESS (7) allows — PRO allows 20.
      const extraUsers = await Promise.all(
        Array.from({ length: 10 }, () => createTestUser({ tenantId: DEFAULT_TENANT_ID, status: "ACTIVE" }))
      );

      const preview = await previewTenantPlanChange(DEFAULT_TENANT_ID, "BUSINESS");
      expect(preview.overLimits).toBe(true);
      expect(preview.overUsers).toBe(true);

      const result = await changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "BUSINESS" }));
      expect(result.ok).toBe(true);

      // Nothing was deleted.
      for (const u of extraUsers) {
        const stillThere = await prismaBase.user.findUnique({ where: { id: u.id } });
        expect(stillThere).not.toBeNull();
        expect(stillThere?.status).toBe("ACTIVE");
      }
      const { plan } = await getTenantPlan(DEFAULT_TENANT_ID);
      expect(plan.code).toBe("BUSINESS");
    });
  });

  describe("CUSTOM (\"Illimité\") — hand-assignable, never self-serve (docs/adr/0035 addendum)", () => {
    it("listAllPlans includes CUSTOM; listOfferedPlans (self-serve comparison) still excludes it", async () => {
      const all = await listAllPlans();
      const offered = await listOfferedPlans();

      expect(all.map((p) => p.code)).toEqual(expect.arrayContaining(["BUSINESS", "PRO", "CUSTOM"]));
      expect(offered.map((p) => p.code)).not.toContain("CUSTOM");
    });

    it(
      "a platform admin can assign CUSTOM to a tenant, and its limits are genuinely unlimited",
      async () => {
        await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });

        const result = await changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "CUSTOM" }));
        expect(result.ok).toBe(true);

        const { plan } = await getTenantPlan(DEFAULT_TENANT_ID);
        expect(plan.code).toBe("CUSTOM");
        expect(plan.maxOrdersPerMonth).toBeNull();
        expect(plan.maxUsers).toBeNull();
        expect(plan.maxWarehouses).toBeNull();

        // Past even PRO's 20-user limit — CUSTOM never trips overLimits.
        for (let i = 0; i < 22; i++) {
          await createTestUser({ tenantId: DEFAULT_TENANT_ID, status: "ACTIVE" });
        }
        const preview = await previewTenantPlanChange(DEFAULT_TENANT_ID, "CUSTOM");
        expect(preview.overLimits).toBe(false);
      },
      15_000
    );
  });

  describe("updateSubscriptionStatusAction", () => {
    it("changes subscription status independently of Tenant.status — a PAST_DUE tenant stays otherwise unaffected", async () => {
      await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
      const result = await updateSubscriptionStatusAction(formData({ tenantId: DEFAULT_TENANT_ID, status: "PAST_DUE" }));
      expect(result.ok).toBe(true);

      const subscription = await prismaBase.tenantSubscription.findUnique({ where: { tenantId: DEFAULT_TENANT_ID } });
      expect(subscription?.status).toBe("PAST_DUE");

      const tenant = await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } });
      expect(tenant.status).toBe("ACTIVE"); // untouched — separate concept (docs/adr/0035)

      const events = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        prisma.auditEvent.findMany({ where: { action: "subscription.suspended" } })
      );
      expect(events.length).toBe(1);
    });

    it("CANCELED sets canceledAt and audits subscription.canceled", async () => {
      await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
      await updateSubscriptionStatusAction(formData({ tenantId: DEFAULT_TENANT_ID, status: "CANCELED" }));

      const subscription = await prismaBase.tenantSubscription.findUnique({ where: { tenantId: DEFAULT_TENANT_ID } });
      expect(subscription?.status).toBe("CANCELED");
      expect(subscription?.canceledAt).not.toBeNull();

      const events = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        prisma.auditEvent.findMany({ where: { action: "subscription.canceled" } })
      );
      expect(events.length).toBe(1);
    });
  });

  describe("updatePlanAction — editing the centralized plan definition", () => {
    // `Plan` is a GLOBAL catalogue, deliberately never wiped by resetDb()
    // (see tests/helpers/db.ts's own comment) — every other test in this
    // suite reads BUSINESS's real 7/3/1500 limits, so a mutation here MUST
    // be restored, exactly like entitlements.test.ts's own
    // requireEntitlement test already does for `features`.
    it("a platform admin can edit a plan's price/limits/features, applying immediately, without leaking the change to other tests", async () => {
      await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
      const plan = await prismaBase.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
      const original = {
        name: plan.name,
        installationPriceMad: plan.installationPriceMad.toString(),
        monthlyPriceMad: plan.monthlyPriceMad.toString(),
        maxOrdersPerMonth: plan.maxOrdersPerMonth,
        maxUsers: plan.maxUsers,
        maxWarehouses: plan.maxWarehouses,
        features: plan.features,
      };

      try {
        const result = await updatePlanAction(
          formData({
            planId: plan.id,
            name: "Business",
            installationPriceMad: "1500",
            monthlyPriceMad: "649",
            maxOrdersPerMonth: "1600",
            maxUsers: "8",
            maxWarehouses: "4",
            features: JSON.stringify(plan.features),
          })
        );
        expect(result.ok).toBe(true);

        const updated = await prismaBase.plan.findUniqueOrThrow({ where: { id: plan.id } });
        expect(updated.monthlyPriceMad.toString()).toBe("649");
        expect(updated.maxUsers).toBe(8);
        expect(updated.maxWarehouses).toBe(4);
      } finally {
        await prismaBase.plan.update({
          where: { id: plan.id },
          data: {
            name: original.name,
            installationPriceMad: original.installationPriceMad,
            monthlyPriceMad: original.monthlyPriceMad,
            maxOrdersPerMonth: original.maxOrdersPerMonth,
            maxUsers: original.maxUsers,
            maxWarehouses: original.maxWarehouses,
            features: original.features as object,
          },
        });
      }
    });
  });

  describe("requestPlanUpgradeAction — client-facing upgrade intent", () => {
    it("settings.manage (OWNER/ADMIN) can request an upgrade; a MANAGER cannot", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      await expect(requestPlanUpgradeAction(formData({ requestedPlanCode: "PRO" }))).rejects.toThrow(/non autorisé/i);

      mockCookieStore.clear();
      const owner = await loginAsTestUser({ role: "OWNER" });
      const result = await requestPlanUpgradeAction(formData({ requestedPlanCode: "PRO" }));
      expect(result.ok).toBe(true);

      const ticket = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        prisma.supportTicket.findUnique({ where: { id: result.ok ? result.data.id : "" } })
      );
      expect(ticket?.category).toBe("upgrade");
      expect(ticket?.reporterUserId).toBe(owner.id);

      const events = await runWithTenant(DEFAULT_TENANT_ID, "test", () =>
        prisma.auditEvent.findMany({ where: { action: "upgrade.requested" } })
      );
      expect(events.length).toBe(1);
      expect(events[0].metadata).toMatchObject({ fromPlan: "BUSINESS", toPlan: "PRO" });
    });
  });
});
