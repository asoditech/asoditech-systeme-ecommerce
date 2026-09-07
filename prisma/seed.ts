/**
 * Bootstraps the minimum needed to log into and operate a fresh
 * environment: the single bootstrap tenant, one OWNER account, a default
 * warehouse, the standard expense categories, and the business settings
 * singleton row. This is NOT demo/fixture data — it creates zero customers,
 * products, orders, or financial history. An empty dashboard after seeding
 * is correct, not a bug (see docs/adr/0002-domain-model.md and the project
 * brief's "Data Integrity Principle").
 *
 * Usage: pnpm db:seed
 * Override the default local credentials with SEED_OWNER_EMAIL /
 * SEED_OWNER_PASSWORD — required in any non-local environment.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const SYSTEM_EXPENSE_CATEGORIES = [
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
];

async function main() {
  const email = process.env.SEED_OWNER_EMAIL ?? "owner@asoditech.local";
  const password = process.env.SEED_OWNER_PASSWORD ?? "change-me-immediately";
  const passwordHash = await bcrypt.hash(password, 12);

  // Phase 4 (docs/adr/0026-multi-tenant-rls.md): every tenant-scoped table
  // now has Postgres Row-Level Security enabled, and this script's
  // DATABASE_URL is the app's restricted runtime role (not the migration
  // owner, which bypasses RLS automatically) — without setting the bypass
  // GUC first, every upsert below would see zero rows and fail its own
  // `WITH CHECK`. One transaction, one bypass, for the whole bootstrap.
  const owner = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);

    // Phase 1 multi-tenant foundation (docs/adr/0023-multi-tenant-foundation.md):
    // the single bootstrap tenant that owns everything. Every `tenantId` column
    // defaults to "default", so nothing below has to reference it explicitly yet.
    await tx.tenant.upsert({
      where: { id: "default" },
      update: {},
      create: { id: "default", name: "ASODITECH", slug: "default" },
    });

    // isPlatformAdmin (Phase 5 — docs/adr/0027-tenant-provisioning.md):
    // until real platform provisioning exists, the bootstrap tenant's
    // OWNER is also the platform operator — the only account with access
    // to /platform (create/activate/suspend OTHER tenants).
    const createdOwner = await tx.user.upsert({
      where: { tenantId_email: { tenantId: "default", email } },
      update: {},
      create: {
        email,
        name: "Propriétaire ASODITECH",
        passwordHash,
        role: "OWNER",
        status: "ACTIVE",
        isPlatformAdmin: true,
      },
    });

    await tx.warehouse.upsert({
      where: { id: "default-warehouse" },
      update: {},
      create: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true },
    });

    await tx.businessSettings.upsert({
      where: { tenantId: "default" },
      update: {},
      create: { id: "singleton" },
    });

    for (const name of SYSTEM_EXPENSE_CATEGORIES) {
      await tx.expenseCategory.upsert({
        where: { tenantId_name: { tenantId: "default", name } },
        update: {},
        create: { name, isSystem: true },
      });
    }

    return createdOwner;
  });

  console.log(`Compte propriétaire prêt : ${owner.email}`);
  if (!process.env.SEED_OWNER_PASSWORD) {
    console.log(`Mot de passe par défaut (local uniquement) : ${password}`);
    console.log("Changez ce mot de passe avant tout déploiement non local.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
