// Raw client on purpose: resetDb must delete rows in EVERY tenant, so it
// must not go through the tenant-scoping extension (docs/adr/0024).
import { prismaBase as prisma } from "@/lib/prisma";

// Refuse to run against anything that doesn't look like a test database —
// resetDb() is destructive (deletes every row in every table).
if (!/test/i.test(process.env.DATABASE_URL ?? "")) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not look like a test database (${process.env.DATABASE_URL}).`
  );
}

/** The single bootstrap tenant every tenantId column defaults to (Phase 1 — docs/adr/0023). */
export const DEFAULT_TENANT_ID = "default";

/** Wipes every table between tests. Test-DB only — never point this at a real database.
 *
 * Callback-form `$transaction` deliberately (Phase 4 — docs/adr/0026): the
 * batch-array form isn't supported on `prismaBase`/`prisma` any more — RLS
 * needs a callback so it can set the bypass GUC as the transaction's first
 * statement, before any of these deletes run. */
export async function resetDb() {
  await prisma.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany();
    // Backup & Portability (docs/adr/0034): backup_runs has a RESTRICT fk to
    // tenants — a leftover row blocks the non-default tenant.deleteMany below.
    // Phase 2 adds the two Google Drive tables (same RESTRICT fk).
    await tx.googleOAuthState.deleteMany();
    await tx.googleDriveConnection.deleteMany();
    await tx.backupRun.deleteMany();
    // Phase 5 (docs/adr/0027-tenant-provisioning.md): invitations has a
    // RESTRICT fk to tenants, so a leftover row would block the non-default
    // tenant.deleteMany below.
    await tx.passwordResetToken.deleteMany();
    await tx.invitation.deleteMany();
    // Support & Help Center: support_tickets has a RESTRICT fk to tenants.
    await tx.supportTicket.deleteMany();
    // Plans/Entitlements/Usage (docs/adr/0035): both have a RESTRICT fk to
    // tenants. `plan` itself is a GLOBAL catalogue (no tenantId) — never
    // wiped here, seeded once by its own migration and left alone.
    await tx.usageAlertState.deleteMany();
    await tx.tenantSubscription.deleteMany();
    await tx.notification.deleteMany();
    await tx.webhookEvent.deleteMany();
    await tx.syncRun.deleteMany();
    await tx.integration.deleteMany();
    await tx.marketingCampaign.deleteMany();
    await tx.marketingChannel.deleteMany();
    await tx.expense.deleteMany();
    await tx.expenseCategory.deleteMany();
    await tx.shipmentWebhookEvent.deleteMany();
    await tx.shipment.deleteMany();
    await tx.deliveryManifest.deleteMany();
    await tx.shippingProvider.deleteMany();
    await tx.commissionEntry.deleteMany();
    await tx.commissionStatement.deleteMany();
    await tx.commissionAgent.deleteMany();
    await tx.refund.deleteMany();
    await tx.orderItem.deleteMany();
    await tx.order.deleteMany();
    await tx.stocktakeLine.deleteMany();
    await tx.stocktakeSession.deleteMany();
    await tx.inventoryMovement.deleteMany();
    await tx.stockTransferLine.deleteMany();
    await tx.stockTransfer.deleteMany();
    await tx.inventoryItem.deleteMany();
    await tx.warehouse.deleteMany();
    await tx.productVariation.deleteMany();
    await tx.productImage.deleteMany();
    await tx.product.deleteMany();
    await tx.category.deleteMany();
    await tx.customerAddress.deleteMany();
    await tx.customer.deleteMany();
    await tx.businessSettings.deleteMany();
    await tx.session.deleteMany();
    await tx.user.deleteMany();
    // Any tenant a test created, but never the bootstrap one — every scoped
    // row's tenantId defaults to it, and the FKs would block the delete anyway.
    await tx.tenant.deleteMany({ where: { id: { not: DEFAULT_TENANT_ID } } });
  });

  // Guarantee the bootstrap tenant exists (a freshly-pushed test DB has
  // none), so the tenantId column default resolves to a real row for every
  // insert — and reset its per-tenant numbering counters (Phase 3 —
  // docs/adr/0025) back to 1: the Tenant row itself survives resetDb (only
  // ROWS are wiped, not the bootstrap tenant), so without this its
  // nextOrderNumber/nextTransferNumber/nextStocktakeNumber would keep
  // climbing across every test in the suite instead of each test getting a
  // fresh count.
  await prisma.tenant.upsert({
    where: { id: DEFAULT_TENANT_ID },
    update: { nextOrderNumber: 1, nextTransferNumber: 1, nextStocktakeNumber: 1 },
    create: { id: DEFAULT_TENANT_ID, name: "ASODITECH", slug: "default" },
  });

  // Every tenant always has exactly one subscription row (docs/adr/0035) —
  // resetDb() just wiped tenant_subscriptions above, so the bootstrap
  // tenant needs one recreated, same BUSINESS/ACTIVE default its own
  // migration seeds for a fresh install. `plans` itself is never wiped
  // (global catalogue, seeded once by its migration), so it's always
  // there to look up.
  const businessPlan = await prisma.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
  await prisma.tenantSubscription.upsert({
    where: { tenantId: DEFAULT_TENANT_ID },
    update: { planId: businessPlan.id, status: "ACTIVE" },
    create: { tenantId: DEFAULT_TENANT_ID, planId: businessPlan.id, status: "ACTIVE" },
  });
}
