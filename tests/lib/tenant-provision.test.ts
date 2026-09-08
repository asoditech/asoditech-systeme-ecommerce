import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { provisionTenantBaseline, SYSTEM_EXPENSE_CATEGORIES } from "@/lib/tenant/provision";
import { resetDb } from "../helpers/db";

// A freshly onboarded tenant must get the baseline rows the app needs to
// be usable — above all the `isDefault` warehouse every stock path keys
// off (docs/adr/0027-tenant-provisioning.md). Before this existed,
// `createTenantAction` created only the Tenant row, so stock sync silently
// no-op'd and the Stock page stayed permanently empty.

const NEW_TENANT = "tenant-provision-test";

describe("provisionTenantBaseline", () => {
  beforeEach(async () => {
    await resetDb();
    await prismaBase.tenant.create({ data: { id: NEW_TENANT, name: "Boutique Test", slug: NEW_TENANT } });
  });
  afterEach(async () => await resetDb());

  it("creates a default warehouse, business settings and the system expense categories", async () => {
    const result = await provisionTenantBaseline(NEW_TENANT, { companyName: "Boutique Test" });

    expect(result.warehouseCreated).toBe(true);
    expect(result.businessSettingsCreated).toBe(true);
    expect(result.expenseCategoriesCreated).toBe(SYSTEM_EXPENSE_CATEGORIES.length);

    await runWithTenant(NEW_TENANT, "test", async () => {
      const warehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
      expect(warehouse).not.toBeNull();
      expect(warehouse!.tenantId).toBe(NEW_TENANT);

      const settings = await prisma.businessSettings.findFirst();
      expect(settings?.companyName).toBe("Boutique Test");

      const categories = await prisma.expenseCategory.findMany();
      expect(categories).toHaveLength(SYSTEM_EXPENSE_CATEGORIES.length);
      expect(categories.every((c) => c.isSystem)).toBe(true);
    });
  });

  it("is idempotent — a second run creates nothing", async () => {
    await provisionTenantBaseline(NEW_TENANT);
    const second = await provisionTenantBaseline(NEW_TENANT);

    expect(second.warehouseCreated).toBe(false);
    expect(second.businessSettingsCreated).toBe(false);
    expect(second.expenseCategoriesCreated).toBe(0);

    await runWithTenant(NEW_TENANT, "test", async () => {
      expect(await prisma.warehouse.count({ where: { isDefault: true } })).toBe(1);
      expect(await prisma.businessSettings.count()).toBe(1);
    });
  });

  it("does not leak baseline rows into another tenant", async () => {
    await provisionTenantBaseline(NEW_TENANT);
    const other = "tenant-provision-other";
    await prismaBase.tenant.create({ data: { id: other, name: "Autre", slug: other } });

    await runWithTenant(other, "test", async () => {
      expect(await prisma.warehouse.count()).toBe(0);
      expect(await prisma.expenseCategory.count()).toBe(0);
    });
  });
});
