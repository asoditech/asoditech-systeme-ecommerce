/**
 * Bootstraps the minimum needed to log into and operate a fresh
 * environment: one OWNER account, a default warehouse, the standard expense
 * categories, and the business settings singleton row. This is NOT
 * demo/fixture data — it creates zero customers, products, orders, or
 * financial history. An empty dashboard after seeding is correct, not a bug
 * (see docs/adr/0002-domain-model.md and the project brief's "Data
 * Integrity Principle").
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

  const owner = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Propriétaire ASODITECH",
      passwordHash,
      role: "OWNER",
      status: "ACTIVE",
    },
  });

  await prisma.warehouse.upsert({
    where: { id: "default-warehouse" },
    update: {},
    create: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true },
  });

  await prisma.businessSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });

  for (const name of SYSTEM_EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { name },
      update: {},
      create: { name, isSystem: true },
    });
  }

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
