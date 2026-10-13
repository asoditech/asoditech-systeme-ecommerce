/**
 * READ-ONLY audit: how many existing customers the identity rule
 * (src/lib/customers/identity.ts — normalized name + normalized phone)
 * would treat as one person but that exist as several rows (history from
 * before the rule). Section 4 of the customer-identity plan (2026-10-05).
 *
 * Reads `customers` (id, tenantId, fullName, phone, createdAt) — nothing
 * else — inside a `READ ONLY` transaction, and writes NOTHING: no merge,
 * no delete, no update. Prints counts
 * per company; customer ids only with `--ids`. Never prints names or phones.
 *
 * Safety: the target database must be named explicitly — the run refuses
 * unless `--target-host=<host>` equals the host of DATABASE_URL, so a
 * wrong `.env` can never be audited by accident. Running it against
 * production needs a separate, explicit authorisation (not done by the
 * 2026-10-13 sessions, which only prepared it).
 *
 * Usage (local example):
 *   npx dotenv -e .env -- tsx scripts/audit-customer-duplicates.ts --target-host=localhost
 *   npx dotenv -e .env -- tsx scripts/audit-customer-duplicates.ts --target-host=localhost --ids
 */
import { PrismaClient } from "@prisma/client";
import { findDuplicateCustomerGroups } from "../src/lib/customers/duplicate-audit";

// A plain client, like prisma/seed.ts: the app's tenant-scoped client is
// server-only, and this audit reads every company's rows on purpose.
const db = new PrismaClient();

function databaseHost(): string | null {
  try {
    return new URL(process.env.DATABASE_URL ?? "").hostname || null;
  } catch {
    return null;
  }
}

async function main() {
  const target = process.argv.find((a) => a.startsWith("--target-host="))?.slice("--target-host=".length);
  const host = databaseHost();
  if (!target || !host || target !== host) {
    console.error(`Refusing to run: pass --target-host=<host of DATABASE_URL>${host ? "" : " (DATABASE_URL is missing or invalid)"}.`);
    process.exitCode = 1;
    return;
  }
  const showIds = process.argv.includes("--ids");

  // One READ ONLY transaction (Postgres itself rejects any write in it), with the
  // RLS escape hatch every unscoped read uses (src/lib/tenant/rls.ts) — without
  // it the customers policy shows zero rows and the audit would wrongly report none.
  const [, , customers] = await db.$transaction([
    db.$executeRawUnsafe("SET TRANSACTION READ ONLY"),
    db.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)"),
    db.customer.findMany({ select: { id: true, tenantId: true, fullName: true, phone: true, createdAt: true } }),
  ]);
  const result = findDuplicateCustomerGroups(customers);
  console.log(`Database host: ${host} — read-only, nothing was changed.`);
  console.log(`Customers scanned: ${result.scanned} (without a usable name/phone, never matched: ${result.unmatchable})`);
  console.log(`Duplicate groups: ${result.groups.length} — surplus rows: ${result.surplusRows}`);
  for (const [tenantId, t] of Object.entries(result.byTenant)) {
    console.log(`  tenant ${tenantId}: ${t.groups} group(s), ${t.surplusRows} surplus row(s)`);
  }
  if (showIds) for (const g of result.groups) console.log(`  ${g.tenantId}: ${g.customerIds.join(", ")} (oldest first)`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "audit failed");
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
