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

/** Wipes every table between tests. Test-DB only — never point this at a real database. */
export async function resetDb() {
  await prisma.$transaction([
    prisma.auditEvent.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.webhookEvent.deleteMany(),
    prisma.syncRun.deleteMany(),
    prisma.integration.deleteMany(),
    prisma.marketingCampaign.deleteMany(),
    prisma.marketingChannel.deleteMany(),
    prisma.expense.deleteMany(),
    prisma.expenseCategory.deleteMany(),
    prisma.shipmentWebhookEvent.deleteMany(),
    prisma.shipment.deleteMany(),
    prisma.deliveryManifest.deleteMany(),
    prisma.shippingProvider.deleteMany(),
    prisma.commissionEntry.deleteMany(),
    prisma.commissionStatement.deleteMany(),
    prisma.commissionAgent.deleteMany(),
    prisma.refund.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.stocktakeLine.deleteMany(),
    prisma.stocktakeSession.deleteMany(),
    prisma.inventoryMovement.deleteMany(),
    prisma.stockTransferLine.deleteMany(),
    prisma.stockTransfer.deleteMany(),
    prisma.inventoryItem.deleteMany(),
    prisma.warehouse.deleteMany(),
    prisma.productVariation.deleteMany(),
    prisma.productImage.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
    prisma.customerAddress.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.businessSettings.deleteMany(),
    prisma.session.deleteMany(),
    prisma.user.deleteMany(),
    // Any tenant a test created, but never the bootstrap one — every scoped
    // row's tenantId defaults to it, and the FKs would block the delete anyway.
    prisma.tenant.deleteMany({ where: { id: { not: DEFAULT_TENANT_ID } } }),
  ]);

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
}
