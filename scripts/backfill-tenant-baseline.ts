/**
 * Backfill the per-tenant baseline (default warehouse, business-settings
 * row, system expense categories) for every existing tenant.
 *
 * Needed once: tenants created by `createTenantAction` BEFORE
 * `provisionTenantBaseline` was wired in (docs/adr/0027-tenant-
 * provisioning.md) have no `isDefault` warehouse, which silently breaks
 * every stock path (WooCommerce/Shopify product sync imports no stock,
 * the Stock page stays empty, manually created products cannot be given
 * stock). Idempotent — a tenant that already has its baseline is left
 * untouched and reported as all-zero. Safe to re-run.
 *
 * Usage:
 *   npx dotenv -e .env -- tsx scripts/backfill-tenant-baseline.ts
 *   npx dotenv -e .env -- tsx scripts/backfill-tenant-baseline.ts --dry-run
 */
import { prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";
import { provisionTenantBaseline } from "@/lib/tenant/provision";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const tenants = await runUnscoped("script:backfill-tenant-baseline", () =>
    prismaBase.tenant.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true } })
  );

  console.log(`${tenants.length} tenant(s) found${dryRun ? " (dry run — no writes)" : ""}.\n`);

  for (const tenant of tenants) {
    if (dryRun) {
      const warehouse = await runUnscoped("script:backfill-tenant-baseline", () =>
        prismaBase.warehouse.findFirst({ where: { tenantId: tenant.id, isDefault: true }, select: { id: true } })
      );
      console.log(
        `  ${tenant.name} (${tenant.id}): default warehouse ${warehouse ? "OK" : "MISSING — would create"}`
      );
      continue;
    }

    const r = await provisionTenantBaseline(tenant.id, { companyName: tenant.name });
    console.log(
      `  ${tenant.name} (${tenant.id}): ` +
        `warehouse ${r.warehouseCreated ? "created" : "ok"}, ` +
        `settings ${r.businessSettingsCreated ? "created" : "ok"}, ` +
        `expense categories +${r.expenseCategoriesCreated}`
    );
  }

  console.log("\nDone.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prismaBase.$disconnect());
