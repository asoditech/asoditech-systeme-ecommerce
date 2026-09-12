import "server-only";

import { prisma } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";

/**
 * The baseline rows every tenant needs before its operators can actually
 * use the app — the same set `prisma/seed.ts` creates for the bootstrap
 * tenant, minus the OWNER account (a new tenant's first user is always
 * provisioned by accepting an invitation — see `createTenantAction`).
 *
 * Until this existed, `createTenantAction` created only the Tenant row and
 * an OWNER invitation, so a freshly onboarded tenant had NO default
 * warehouse. Every stock path keys off
 * `warehouse.findFirst({ where: { isDefault: true } })`
 * (`getDefaultWarehouseId`, the WooCommerce/Shopify product sync,
 * `createProductAction`'s stock seeding) and silently no-ops when it comes
 * back null — so stock sync imported nothing, the Stock page stayed empty,
 * and manually created products could not be given stock. See
 * docs/adr/0027-tenant-provisioning.md.
 */

/** Keep in sync with `SYSTEM_EXPENSE_CATEGORIES` in prisma/seed.ts. */
export const SYSTEM_EXPENSE_CATEGORIES = [
  "Publicité",
  "Livraison",
  "Packaging",
  "Achats",
  "Salaires",
  "Outils SaaS",
  "Hébergement",
  "Domaine",
  "Frais bancaires",
  "Autres",
] as const;

export interface TenantBaselineResult {
  warehouseCreated: boolean;
  businessSettingsCreated: boolean;
  expenseCategoriesCreated: number;
  subscriptionCreated: boolean;
}

/**
 * Idempotent: safe to call on a brand-new tenant AND to re-run against a
 * tenant that already has some or all of its baseline (the backfill
 * script does exactly that). Every write is guarded by an existence check
 * or an upsert on a per-tenant unique key, so a second run creates
 * nothing and reports all-zero.
 *
 * Runs pinned to `tenantId` via `runWithTenant`, so the Prisma tenant
 * extension stamps `tenantId` onto every create and the row lands in the
 * right workspace — the caller does NOT need to already be in that
 * context.
 */
export async function provisionTenantBaseline(
  tenantId: string,
  opts: { companyName?: string } = {}
): Promise<TenantBaselineResult> {
  return runWithTenant(tenantId, "tenant:provision-baseline", async () => {
    const result: TenantBaselineResult = {
      warehouseCreated: false,
      businessSettingsCreated: false,
      expenseCategoriesCreated: 0,
      subscriptionCreated: false,
    };

    const existingDefaultWarehouse = await prisma.warehouse.findFirst({ where: { isDefault: true } });
    if (!existingDefaultWarehouse) {
      await prisma.warehouse.create({
        data: { name: "Entrepôt principal", isDefault: true, type: "ENTREPOT" },
      });
      result.warehouseCreated = true;
    }

    const existingSettings = await prisma.businessSettings.findFirst();
    if (!existingSettings) {
      await prisma.businessSettings.create({
        data: opts.companyName ? { companyName: opts.companyName } : {},
      });
      result.businessSettingsCreated = true;
    }

    for (const name of SYSTEM_EXPENSE_CATEGORIES) {
      const existing = await prisma.expenseCategory.findFirst({ where: { name } });
      if (!existing) {
        await prisma.expenseCategory.create({ data: { name, isSystem: true } });
        result.expenseCategoriesCreated++;
      }
    }

    // Every tenant always has exactly one subscription row (docs/adr/0035)
    // — defaults to BUSINESS/ACTIVE, a safe, reversible starting point a
    // platform admin can change per tenant at any time via
    // /platform/plans. `Plan` is a global catalogue (no tenantId), so it
    // passes through the tenant extension untouched regardless of which
    // tenant is active here — same as any `prisma.tenant.*` call.
    const existingSubscription = await prisma.tenantSubscription.findFirst();
    if (!existingSubscription) {
      const businessPlan = await prisma.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
      await prisma.tenantSubscription.create({
        data: { planId: businessPlan.id, status: "ACTIVE" },
      });
      result.subscriptionCreated = true;
    }

    return result;
  });
}
