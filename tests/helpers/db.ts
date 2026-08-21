import { prisma } from "@/lib/prisma";

// Refuse to run against anything that doesn't look like a test database —
// resetDb() is destructive (deletes every row in every table).
if (!/test/i.test(process.env.DATABASE_URL ?? "")) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL does not look like a test database (${process.env.DATABASE_URL}).`
  );
}

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
    prisma.shippingProvider.deleteMany(),
    prisma.refund.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.inventoryMovement.deleteMany(),
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
  ]);
}
