import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { updateCostingMethodAction } from "@/actions/settings";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Product costing (Phase 3 — Product Costing & Profitability input) —
 * updateCostingMethodAction. See src/lib/receptions.ts for what the chosen
 * method actually drives; this file only covers the setting itself:
 * authorization, tenant isolation, persistence, and the default.
 */

function formData(costingMethod: string) {
  const fd = new FormData();
  fd.set("costingMethod", costingMethod);
  return fd;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("updateCostingMethodAction", () => {
  it("default (never saved) is MANUAL — the column's own DB default", async () => {
    await loginAsTestUser({ role: "OWNER" });
    // No prior upsert() at all — mirrors a tenant that has never opened
    // /parametres yet, exactly like a genuinely fresh install.
    const settings = await prisma.businessSettings.findFirst();
    expect(settings === null || settings.costingMethod === "MANUAL").toBe(true);
  });

  it("a user with settings.manage can change the costing method, and it persists across a later read", async () => {
    const owner = await loginAsTestUser({ role: "OWNER" });
    const result = await updateCostingMethodAction(formData("WEIGHTED_AVERAGE"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.costingMethod).toBe("WEIGHTED_AVERAGE");

    // A fresh read, as a later page load / a different action call would do.
    const reread = await prisma.businessSettings.findUniqueOrThrow({ where: { tenantId: owner.tenantId } });
    expect(reread.costingMethod).toBe("WEIGHTED_AVERAGE");

    // Changing it again overwrites cleanly (an upsert, not an insert-only path).
    const second = await updateCostingMethodAction(formData("LAST_COST"));
    expect(second.ok).toBe(true);
    const rereadAgain = await prisma.businessSettings.findUniqueOrThrow({ where: { tenantId: owner.tenantId } });
    expect(rereadAgain.costingMethod).toBe("LAST_COST");
  });

  it("rejects a caller without settings.manage — server-side, not just a hidden UI control", async () => {
    // CONFIRMATION holds neither settings.view nor settings.manage.
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(updateCostingMethodAction(formData("LAST_COST"))).rejects.toThrow(/non autorisé/i);
    // Nothing was written.
    const settings = await prisma.businessSettings.findFirst();
    expect(settings === null || settings.costingMethod === "MANUAL").toBe(true);
  });

  it("rejects an invalid costing method value", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const result = await updateCostingMethodAction(formData("NOT_A_REAL_METHOD"));
    expect(result.ok).toBe(false);
  });

  it("tenant isolation: a change in one tenant never touches another tenant's costing method", async () => {
    const TENANT_B = "tenant-b-settings-costing";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    await prismaBase.businessSettings.create({ data: { tenantId: TENANT_B, costingMethod: "WEIGHTED_AVERAGE" } });

    await loginAsTestUser({ role: "OWNER", tenantId: DEFAULT_TENANT_ID });
    const result = await updateCostingMethodAction(formData("LAST_COST"));
    expect(result.ok).toBe(true);

    const tenantARow = await prismaBase.businessSettings.findUniqueOrThrow({ where: { tenantId: DEFAULT_TENANT_ID } });
    expect(tenantARow.costingMethod).toBe("LAST_COST");
    // Untouched — the action only ever upserts the ACTING user's own tenant.
    const tenantBRow = await prismaBase.businessSettings.findUniqueOrThrow({ where: { tenantId: TENANT_B } });
    expect(tenantBRow.costingMethod).toBe("WEIGHTED_AVERAGE");
  });
});
