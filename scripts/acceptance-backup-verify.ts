/** Post-restore DB verification for the acceptance test (docs/adr/0034). */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

const REPLACE_COUNTS: Record<string, number> = {
  product: 6, productVariation: 4, category: 2, customer: 12, customerAddress: 12,
  order: 12, orderItem: 12, refund: 2, warehouse: 2, inventoryItem: 12, inventoryMovement: 11,
  stockTransfer: 1, stockTransferLine: 1, stocktakeSession: 1, stocktakeLine: 3, shipment: 4,
  deliveryCityMapping: 1, shippingProvider: 1, orderConfirmationAttempt: 3, commissionAgent: 1,
  commissionEntry: 1, expense: 4, expenseCategory: 1, marketingChannel: 1, marketingCampaign: 1,
  integration: 2,
};

async function count(model: string, where: object) {
  return (prisma as unknown as Record<string, { count: (a: unknown) => Promise<number> }>)[model].count({ where });
}

async function main() {
  const results: { check: string; pass: boolean; detail: string }[] = [];
  const rec = (check: string, pass: boolean, detail: string) => {
    results.push({ check, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${check} — ${detail}`);
  };

  // 5 — replace-model counts exactly match the backup for tenant A.
  const mism: string[] = [];
  for (const [m, expected] of Object.entries(REPLACE_COUNTS)) {
    const actual = await count(m, { tenantId: "default" });
    if (actual !== expected) mism.push(`${m}: ${actual}≠${expected}`);
  }
  rec("5 restored replace-model counts match the package", mism.length === 0, mism.length ? mism.join(", ") : "all 26 models exact");

  // 5 — relationships intact: an order with its items + customer; a variable product; category tree.
  const order = await prisma.order.findFirst({
    where: { tenantId: "default" },
    include: { items: true, customer: { include: { addresses: true } } },
  });
  rec(
    "5 order → items + customer relationship intact",
    !!order && order.items.length > 0 && !!order.customer && order.customer.addresses.length > 0,
    `order ${order?.id?.slice(0, 8)} items=${order?.items.length} customer=${order?.customer?.fullName} addrs=${order?.customer.addresses.length}`
  );
  const varProd = await prisma.product.findFirst({
    where: { tenantId: "default", variations: { some: {} } },
    include: { variations: true, category: { include: { parent: true } } },
  });
  rec(
    "5 variable product → variations + category tree (deferred self-FK) intact",
    !!varProd && varProd.variations.length === 2 && !!varProd.category?.parentId && !!varProd.category.parent,
    `product ${varProd?.name} vars=${varProd?.variations.length} cat=${varProd?.category?.name} parent=${varProd?.category?.parent?.name}`
  );
  const shipment = await prisma.shipment.findFirst({ where: { tenantId: "default" }, include: { order: true, provider: true } });
  rec(
    "5 shipment → order + provider + tracking history intact",
    !!shipment && !!shipment.order && !!shipment.provider && Array.isArray(shipment.trackingEvents),
    `shipment ${shipment?.trackingNumber} order#${shipment?.order?.orderNumber} provider=${shipment?.provider?.name} events=${(shipment?.trackingEvents as unknown[])?.length}`
  );
  const movements = await prisma.inventoryMovement.findMany({ where: { tenantId: "default", stockTransferId: { not: null } } });
  rec(
    "5 inventory movement → deferred stockTransferId FK restored",
    movements.length === 1 && !!movements[0].stockTransferId,
    `${movements.length} transfer-linked movement(s)`
  );

  // 6 — integrations + shipping providers disconnected, no credentials.
  const integs = await prisma.integration.findMany({ where: { tenantId: "default" } });
  const provs = await prisma.shippingProvider.findMany({ where: { tenantId: "default" } });
  const badInteg = integs.filter((i) => i.status !== "DECONNECTE" || i.credentialsEncrypted !== null || i.lastError !== null);
  const badProv = provs.filter((p) => p.credentialsEncrypted !== null || p.connectionStatus !== "DECONNECTE");
  rec(
    "6 integrations DECONNECTE + credential-free after restore",
    badInteg.length === 0,
    `${integs.length} integrations — statuses: ${integs.map((i) => `${i.provider}:${i.status}/creds=${i.credentialsEncrypted}`).join(", ")}`
  );
  rec(
    "6 shipping providers DECONNECTE + credential-free after restore",
    badProv.length === 0,
    `${provs.length} providers — ${provs.map((p) => `${p.name}:${p.connectionStatus}/creds=${p.credentialsEncrypted}`).join(", ")}`
  );
  // config secrets also scrubbed from the restored integration
  const wooCfg = (integs.find((i) => i.provider === "WOOCOMMERCE")?.config ?? {}) as Record<string, unknown>;
  rec(
    "6 restored integration config carries storeUrl but not the secret keys",
    wooCfg.storeUrl != null && wooCfg.consumerSecret == null && wooCfg.webhookSecret == null,
    `config keys: ${Object.keys(wooCfg).join(", ")}`
  );

  // 7 — a PRE_RESTORE_SNAPSHOT was created and is a real downloadable artifact.
  const snapshots = await prisma.backupRun.findMany({
    where: { tenantId: "default", type: "PRE_RESTORE_SNAPSHOT" },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, sizeBytes: true, payload: true, expiresAt: true, note: true },
  });
  rec(
    "7 pre-restore safety snapshot created before the restore",
    snapshots.length >= 1 && snapshots[0].status === "READY" && (snapshots[0].payload?.length ?? 0) > 0 && snapshots[0].expiresAt != null,
    `${snapshots.length} snapshot(s); latest ${snapshots[0]?.id?.slice(0, 8)} status=${snapshots[0]?.status} bytes=${snapshots[0]?.payload?.length} expires=${snapshots[0]?.expiresAt?.toISOString()}`
  );

  // consumed upload row -> RESTORED, payload dropped
  const upload = await prisma.backupRun.findFirst({
    where: { tenantId: "default", type: "RESTORE_UPLOAD" },
    orderBy: { createdAt: "desc" },
  });
  rec(
    "restore upload row marked RESTORED with payload dropped",
    upload?.status === "RESTORED" && upload.payload === null,
    `upload ${upload?.id?.slice(0, 8)} status=${upload?.status} payload=${upload?.payload === null ? "null" : "present"}`
  );

  // users merged, not deleted; audit appended not wiped
  const users = await prisma.user.count({ where: { tenantId: "default" } });
  const audit = await prisma.auditEvent.count({ where: { tenantId: "default" } });
  const restoredEvent = await prisma.auditEvent.findFirst({ where: { tenantId: "default", action: "backup.restored" } });
  rec(
    "users merged not deleted; audit appended (restore event present)",
    users === 2 && audit >= 8 && !!restoredEvent,
    `users=${users} auditEvents=${audit} backup.restored=${!!restoredEvent}`
  );

  // 8 — tenant B untouched by A's restore.
  const bOrders = await prisma.order.count({ where: { tenantId: "tenant-acme" } });
  const bProducts = await prisma.product.count({ where: { tenantId: "tenant-acme" } });
  const bInteg = await prisma.integration.findMany({ where: { tenantId: "tenant-acme" } });
  rec(
    "8e tenant B business data completely untouched by A's restore",
    bOrders === 8 && bProducts === 4 && bInteg.every((i) => i.status === "CONNECTE"),
    `B orders=${bOrders} products=${bProducts} integrations still CONNECTE=${bInteg.every((i) => i.status === "CONNECTE")}`
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== POST-RESTORE VERIFY: ${results.length - failed.length}/${results.length} PASS ====`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
