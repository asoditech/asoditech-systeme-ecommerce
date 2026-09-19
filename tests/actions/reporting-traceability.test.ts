import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { createReceptionAction, validateReceptionAction, createSupplierAction } from "@/actions/purchases";
import { quickSearchAction } from "@/actions/search";
import { getCurrentUser, createSession } from "@/lib/auth/session";
import { listSales, getSaleDetail } from "@/lib/queries/sales";
import { getChannelReport } from "@/lib/queries/reports/channels";
import { getFinanceSummary } from "@/lib/queries/finance";
import { getUnitTraceability, findTraceUnits } from "@/lib/queries/traceability";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import { buildTenantBackup } from "@/lib/backup/export";
import { inspectBackup, restoreTenantBackup } from "@/lib/backup/import";
import { deleteTenantData } from "@/lib/tenant/delete";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { GET as exportReport } from "@/app/(protected)/rapports/export/[type]/route";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Phase G — reporting (Online / Offline / Total), traceability and scoping
 * across shared surfaces (docs/adr/0039, 0040).
 */

beforeEach(async () => {
  await resetDb();
  // These suites cover the Offline capabilities, which exist only in an
  // ONLINE_AND_OFFLINE tenant (docs/adr/0041).
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const range = () => ({ from: new Date(Date.now() - 24 * 3600 * 1000), to: new Date(Date.now() + 24 * 3600 * 1000) });

/** Two stores (channels + locations) sharing ONE product, plus an Online order. */
async function seedWorld() {
  const online = await ensureDefaultOnlineChannel();
  const whA = await prisma.warehouse.create({ data: { name: "Boutique A", type: "MAGASIN", isDefault: true } });
  const whB = await prisma.warehouse.create({ data: { name: "Boutique B", type: "MAGASIN" } });
  const chA = await prisma.salesChannel.create({ data: { name: "Magasin A", kind: "OFFLINE" } });
  const chB = await prisma.salesChannel.create({ data: { name: "Magasin B", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.createMany({ data: [{ salesChannelId: chA.id, warehouseId: whA.id }, { salesChannelId: chB.id, warehouseId: whB.id }] });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 100, status: "ACTIF", cost: 40 } });
  await prisma.productSalesChannel.createMany({
    data: [{ productId: product.id, salesChannelId: online.id }, { productId: product.id, salesChannelId: chA.id }, { productId: product.id, salesChannelId: chB.id }],
  });
  const itemA = await prisma.inventoryItem.create({ data: { warehouseId: whA.id, productId: product.id, quantityOnHand: 20 } });
  const itemB = await prisma.inventoryItem.create({ data: { warehouseId: whB.id, productId: product.id, quantityOnHand: 20 } });

  // One delivered ONLINE order worth 1 000.
  const customer = await prisma.customer.create({ data: { fullName: "Client Online" } });
  const order = await prisma.order.create({
    data: {
      customerId: customer.id, status: "LIVREE", subtotal: 1000, total: 1000, salesChannelId: online.id, placedAt: new Date(),
      items: { create: [{ productId: product.id, nameSnapshot: "Basket", skuSnapshot: "BASKET-1", unitPrice: 100, quantity: 10, total: 1000, costSnapshot: 40 }] },
    },
  });
  return { online, whA, whB, chA, chB, product, itemA, itemB, order };
}

async function sell(chId: string, whId: string, productId: string, qty: number, method: "ESPECES" | "CARTE" = "ESPECES") {
  const r = await createSaleAction({
    salesChannelId: chId, warehouseId: whId, idempotencyKey: randomUUID(),
    lines: [{ productId, quantity: qty }], payments: [{ method, amount: qty * 100 }],
  });
  if (!r.ok) throw new Error("sale failed: " + r.error);
  return r.data.id;
}

async function loginScoped(role: "MANAGER" | "ACCOUNTANT", channelIds: string[], locationIds: string[] = []) {
  mockCookieStore.clear();
  const u = await loginAsTestUser({ role, channels: "none" });
  if (channelIds.length) await grantChannelAccess(u.id, channelIds);
  if (locationIds.length) await grantLocationAccess(u.id, locationIds);
  return (await getCurrentUser())!;
}

describe("channel report — Online / Offline / Total from the underlying sources", () => {
  it("Online is the EXISTING order-revenue figure (unchanged), Offline comes from Sales, Total is their sum with no double count", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await sell(w.chA.id, w.whA.id, w.product.id, 3); // 300
    await sell(w.chB.id, w.whB.id, w.product.id, 2, "CARTE"); // 200
    const admin = (await getCurrentUser())!;

    const r = await getChannelReport(admin, range());
    const existing = await getFinanceSummary(range());
    expect(r.online?.revenue).toBe(Number(existing.revenue)); // definition unchanged
    expect(r.online?.revenue).toBe(1000);
    expect(r.online?.ordersCount).toBe(1);
    expect(r.offline).toMatchObject({ grossSales: 500, refunds: 0, netSales: 500, salesCount: 2, unitsSold: 5 });
    expect(r.total?.revenue).toBe(1500); // 1 000 + 500 — each source counted once
    expect(r.offline?.byPayment.sort((a, b) => a.method.localeCompare(b.method))).toEqual([{ method: "CARTE", amount: 200 }, { method: "ESPECES", amount: 300 }]);
    expect(r.offline?.byChannel.map((c) => [c.name, c.gross]).sort()).toEqual([["Magasin A", 300], ["Magasin B", 200]]);
  });

  it("refunds on returns are netted from Offline in the period they were paid; Online is unaffected", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    const saleId = await sell(w.chA.id, w.whA.id, w.product.id, 4); // 400
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId } });
    const ret = await createSaleReturnAction({
      saleId, idempotencyKey: randomUUID(), lines: [{ saleLineId: line.id, quantitySellable: 1, quantityDamaged: 0 }],
      refundAmount: 100, refundMethod: "ESPECES",
    });
    expect(ret.ok).toBe(true);
    const r = await getChannelReport((await getCurrentUser())!, range());
    expect(r.offline).toMatchObject({ grossSales: 400, refunds: 100, netSales: 300 });
    expect(r.online?.revenue).toBe(1000);
    expect(r.total?.revenue).toBe(1300);
    expect(admin.id).toBeTruthy();
  });

  it("an ONLINE-only user gets no Offline figure and no Total; an OFFLINE-only user gets no Online figure and no Total", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await sell(w.chA.id, w.whA.id, w.product.id, 3);

    const onlineOnly = await loginScoped("MANAGER", [w.online.id]);
    const a = await getChannelReport(onlineOnly, range());
    expect(a.offline).toBeNull();
    expect(a.total).toBeNull();
    expect(a.online?.revenue).toBe(1000);

    const offlineOnly = await loginScoped("MANAGER", [w.chA.id]);
    const b = await getChannelReport(offlineOnly, range());
    expect(b.online).toBeNull();
    expect(b.total).toBeNull();
    expect(b.offline?.grossSales).toBe(300);
  });

  it("a store user sees ONLY their own store's numbers; a combined user sees Online + their stores", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await sell(w.chA.id, w.whA.id, w.product.id, 3); // 300
    await sell(w.chB.id, w.whB.id, w.product.id, 5); // 500

    const storeA = await loginScoped("MANAGER", [w.chA.id]);
    expect((await getChannelReport(storeA, range())).offline?.grossSales).toBe(300);

    const combined = await loginScoped("MANAGER", [w.online.id, w.chB.id]);
    const c = await getChannelReport(combined, range());
    expect(c.offline?.grossSales).toBe(500);
    expect(c.total?.revenue).toBe(1500);
  });

  it("kind and store filters narrow the report without crossing scope", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await sell(w.chA.id, w.whA.id, w.product.id, 3);
    await sell(w.chB.id, w.whB.id, w.product.id, 5);
    const admin = (await getCurrentUser())!;
    const onlyOffline = await getChannelReport(admin, range(), { kind: "offline" });
    expect(onlyOffline.online).toBeNull();
    expect(onlyOffline.total).toBeNull();
    const storeB = await getChannelReport(admin, range(), { salesChannelId: w.chB.id });
    expect(storeB.offline?.grossSales).toBe(500);
    expect(storeB.online).toBeNull(); // a store filter is not an Online question
  });

  it("the CSV export enforces the same scope (no Offline rows for an Online-only user; refused with no channel at all)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await sell(w.chA.id, w.whA.id, w.product.id, 3);

    await loginScoped("MANAGER", [w.online.id]);
    const csv = await (await exportReport(new Request("http://x/rapports/export/canaux"), { params: Promise.resolve({ type: "canaux" }) })).text();
    expect(csv).toContain("En ligne");
    expect(csv).not.toContain("Magasin");

    await loginScoped("MANAGER", []);
    const res = await exportReport(new Request("http://x/rapports/export/canaux"), { params: Promise.resolve({ type: "canaux" }) });
    expect(res.status).toBe(403);
  });
});

describe("sales reads are row-scoped", () => {
  it("listSales / getSaleDetail / the sale search never return another store's sale", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    const idA = await sell(w.chA.id, w.whA.id, w.product.id, 1);
    const idB = await sell(w.chB.id, w.whB.id, w.product.id, 1);
    const saleB = await prisma.sale.findUniqueOrThrow({ where: { id: idB } });

    const storeA = await loginScoped("MANAGER", [w.chA.id], [w.whA.id]);
    const listed = await listSales(storeA);
    expect(listed.sales.map((s) => s.id)).toEqual([idA]);
    expect(listed.total).toBe(1);
    expect(await getSaleDetail(storeA, idB)).toBeNull();
    expect(await getSaleDetail(storeA, idA)).not.toBeNull();
    expect((await prisma.sale.findMany({ where: saleChannelWhere(storeA) })).map((s) => s.id)).toEqual([idA]);

    // the global search honours the same scope
    const found = await quickSearchAction(String(saleB.displayNumber ?? saleB.saleNumber));
    expect(found.some((r) => r.type === "sale" && r.id === idB)).toBe(false);
  });

  it("an ONLINE-only user sees no sales anywhere (search included)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    const id = await sell(w.chA.id, w.whA.id, w.product.id, 1);
    const online = await loginScoped("MANAGER", [w.online.id]);
    expect((await listSales(online)).total).toBe(0);
    expect(await getSaleDetail(online, id)).toBeNull();
    expect((await quickSearchAction("VTE")).every((r) => r.type !== "sale")).toBe(true);
  });
});

describe("traceability — one ledger, from entry to sale to return", () => {
  it("follows a unit from reception (supplier + cost) through a sale and a return, with signed effects and running balances", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await prisma.barcode.create({ data: { code: "6111111111111", productId: w.product.id, isPrimary: true } });
    const sup = await createSupplierAction({ name: "Fournisseur Casa" });
    if (!sup.ok) throw new Error("setup");
    const rec = await createReceptionAction({ supplierId: sup.data.id, warehouseId: w.whA.id, lines: [{ productId: w.product.id, quantity: 10, unitCost: 55 }] });
    if (!rec.ok) throw new Error("setup");
    await validateReceptionAction({ id: rec.data.id }); // A: 20 → 30
    const saleId = await sell(w.chA.id, w.whA.id, w.product.id, 4); // 30 → 26
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId } });
    await createSaleReturnAction({ saleId, idempotencyKey: randomUUID(), lines: [{ saleLineId: line.id, quantitySellable: 1, quantityDamaged: 1 }] });

    const units = await findTraceUnits("6111111111111");
    expect(units).toHaveLength(1);
    const t = await getUnitTraceability((await getCurrentUser())!, { productId: units[0].productId, variationId: null });
    if (!t) throw new Error("no trace");

    expect(t.identity.barcodes).toEqual([{ code: "6111111111111", isPrimary: true }]);
    expect(t.stock.map((s) => [s.warehouseName, s.onHand]).sort()).toEqual([["Boutique A", 27], ["Boutique B", 20]]); // 26 + 1 sellable back

    const reception = t.movements.find((m) => m.type === "RECEPTION")!;
    expect(reception).toMatchObject({ onHandDelta: 10, onHandAfter: 30, unitCost: 55, actor: admin.name });
    expect(reception.document).toMatchObject({ kind: "reception", extra: "Fournisseur Casa" });

    const vente = t.movements.find((m) => m.type === "VENTE")!;
    expect(vente).toMatchObject({ onHandDelta: -4, onHandAfter: 26 });
    expect(vente.document).toMatchObject({ kind: "sale" });

    const retour = t.movements.find((m) => m.type === "RETOUR")!;
    expect(retour).toMatchObject({ onHandDelta: 1, onHandAfter: 27 });
    expect(retour.document).toMatchObject({ kind: "sale_return" });
    const damaged = t.movements.find((m) => m.type === "ENDOMMAGE")!;
    expect(damaged.onHandDelta).toBe(0); // never added to sellable stock
    expect(t.movements.every((m) => !m.legacy)).toBe(true);
  });

  it("pre-cut-over movements are flagged as legacy — never given an invented origin", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    // A movement as written before this change: no delta, no balance, no document.
    await prismaBase.inventoryMovement.create({
      data: { inventoryItemId: w.itemA.id, warehouseId: w.whA.id, type: "AJUSTEMENT_POSITIF", quantity: 5, tenantId: "default" },
    });
    const t = await getUnitTraceability((await getCurrentUser())!, { productId: w.product.id, variationId: null });
    const legacy = t!.movements[0];
    expect(legacy).toMatchObject({ legacy: true, onHandDelta: null, onHandAfter: null, document: null });
  });

  it("the timeline is scoped to the viewer's channels — sales of another store, and Online movements, stay hidden", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    // Move stock so BOTH stores' movements hit the SAME unit; add an online-order movement too.
    await sell(w.chA.id, w.whA.id, w.product.id, 1);
    await sell(w.chB.id, w.whB.id, w.product.id, 2);
    await prisma.inventoryMovement.create({
      data: { inventoryItemId: w.itemA.id, warehouseId: w.whA.id, type: "VENTE", quantity: 1, onHandDelta: -1, orderId: w.order.id },
    });

    const admin = await getUnitTraceability((await getCurrentUser())!, { productId: w.product.id, variationId: null });
    expect(admin!.movements.filter((m) => m.type === "VENTE")).toHaveLength(3);

    const storeA = await loginScoped("MANAGER", [w.chA.id]);
    const a = await getUnitTraceability(storeA, { productId: w.product.id, variationId: null });
    const docsA = a!.movements.map((m) => m.document?.kind);
    expect(docsA.filter((k) => k === "sale")).toHaveLength(1); // only Store A's own sale
    expect(docsA).not.toContain("order"); // and no Online movement

    const onlineOnly = await loginScoped("MANAGER", [w.online.id]);
    const o = await getUnitTraceability(onlineOnly, { productId: w.product.id, variationId: null });
    expect(o!.movements.map((m) => m.document?.kind)).not.toContain("sale");
    expect(o!.movements.map((m) => m.document?.kind)).toContain("order");
  });
});

describe("shared reports respect channel scope", () => {
  it("stock rotation counts only the activities the viewer may read", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld(); // online order: 10 units
    await sell(w.chA.id, w.whA.id, w.product.id, 3);
    await sell(w.chB.id, w.whB.id, w.product.id, 2);
    const sold = async (opts: Parameters<typeof getStockValuationReport>[0]) =>
      (await getStockValuationReport(opts)).rows.filter((r) => r.sku === "BASKET-1").map((r) => r.unitsSoldInWindow)[0];

    expect(await sold({})).toBe(10); // historical default: Online orders only — unchanged
    expect(await sold({ offlineSaleScope: {} })).toBe(15); // + all in-store sales
    expect(await sold({ includeOnlineOrders: false, offlineSaleScope: { salesChannelId: { in: [w.chA.id] } } })).toBe(3); // Store A user
    expect(await sold({ includeOnlineOrders: false, offlineSaleScope: null })).toBe(0); // no channel → none
  });

  it("the audit log query filter hides Offline events from an Online-only user (server-side)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await sell(w.chA.id, w.whA.id, w.product.id, 1);
    expect(await prisma.auditEvent.count({ where: { action: "sale.created" } })).toBe(1);
    const { auditScopeWhere } = await import("@/lib/auth/audit-scope");
    const visible = await prisma.auditEvent.findMany({ where: auditScopeWhere({ global: false, online: true, offline: false }) });
    expect(visible.some((e) => e.action === "sale.created")).toBe(false);
  });
});

describe("backup / restore and tenant deletion cover the new tables", () => {
  it("a backup round-trips channels, barcodes, suppliers, receptions, sales, payments and returns, with document links intact", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    await prisma.barcode.create({ data: { code: "BK-CODE-1", productId: w.product.id, isPrimary: true } });
    const sup = await createSupplierAction({ name: "Fournisseur Backup" });
    if (!sup.ok) throw new Error("setup");
    const rec = await createReceptionAction({ supplierId: sup.data.id, warehouseId: w.whA.id, lines: [{ productId: w.product.id, quantity: 5, unitCost: 10 }] });
    if (!rec.ok) throw new Error("setup");
    await validateReceptionAction({ id: rec.data.id });
    const saleId = await sell(w.chA.id, w.whA.id, w.product.id, 2);
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId } });
    await createSaleReturnAction({ saleId, idempotencyKey: randomUUID(), lines: [{ saleLineId: line.id, quantitySellable: 1, quantityDamaged: 0 }], refundAmount: 100, refundMethod: "ESPECES" });

    const before = {
      channels: await prisma.salesChannel.count(), barcodes: await prisma.barcode.count(), suppliers: await prisma.supplier.count(),
      receptions: await prisma.reception.count(), sales: await prisma.sale.count(), payments: await prisma.salePayment.count(),
      returns: await prisma.saleReturn.count(), movements: await prisma.inventoryMovement.count(),
      linkedMovements: await prisma.inventoryMovement.count({ where: { OR: [{ receptionLineId: { not: null } }, { saleId: { not: null } }, { saleReturnId: { not: null } }] } }),
    };
    const backup = await buildTenantBackup({ tenantId: "default", createdByUserId: null });
    const inspected = inspectBackup(backup.container);
    expect(inspected.valid).toBe(true);
    await restoreTenantBackup({ activeTenantId: "default", inspected });

    expect(await prisma.salesChannel.count()).toBe(before.channels);
    expect(await prisma.barcode.count()).toBe(before.barcodes);
    expect(await prisma.supplier.count()).toBe(before.suppliers);
    expect(await prisma.reception.count()).toBe(before.receptions);
    expect(await prisma.sale.count()).toBe(before.sales);
    expect(await prisma.salePayment.count()).toBe(before.payments);
    expect(await prisma.saleReturn.count()).toBe(before.returns);
    expect(await prisma.inventoryMovement.count()).toBe(before.movements);
    expect(
      await prisma.inventoryMovement.count({ where: { OR: [{ receptionLineId: { not: null } }, { saleId: { not: null } }, { saleReturnId: { not: null } }] } })
    ).toBe(before.linkedMovements);
    // the restored ledger still carries its new columns
    const m = await prisma.inventoryMovement.findFirstOrThrow({ where: { type: "VENTE" } });
    expect(m.onHandDelta).toBe(-2);
  });

  it("deleting a tenant that owns channels, sales, receptions and barcodes succeeds (registry order is valid)", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-del-e2e", name: "Del", slug: "tenant-del-e2e" } });
    const t = "tenant-del-e2e";
    const wh = await prismaBase.warehouse.create({ data: { name: "W", type: "MAGASIN", isDefault: true, tenantId: t } });
    const ch = await prismaBase.salesChannel.create({ data: { name: "M", kind: "OFFLINE", tenantId: t } });
    await prismaBase.salesChannelLocation.create({ data: { salesChannelId: ch.id, warehouseId: wh.id, tenantId: t } });
    const p = await prismaBase.product.create({ data: { name: "P", sku: "P-DEL", price: 1, tenantId: t } });
    await prismaBase.barcode.create({ data: { code: "DEL-CODE", productId: p.id, tenantId: t } });
    await prismaBase.productSalesChannel.create({ data: { productId: p.id, salesChannelId: ch.id, tenantId: t } });
    const sup = await prismaBase.supplier.create({ data: { name: "S", tenantId: t } });
    const rec = await prismaBase.reception.create({ data: { supplierId: sup.id, warehouseId: wh.id, tenantId: t } });
    await prismaBase.supplierPayment.create({ data: { supplierId: sup.id, receptionId: rec.id, amount: 5, tenantId: t } });
    const sale = await prismaBase.sale.create({
      data: { salesChannelId: ch.id, warehouseId: wh.id, idempotencyKey: "del-key-0001", subtotal: 1, total: 1, tenantId: t,
        lines: { create: [{ productId: p.id, nameSnapshot: "P", skuSnapshot: "P-DEL", unitPrice: 1, quantity: 1, total: 1, tenantId: t }] },
        payments: { create: [{ amount: 1, tenantId: t }] } },
    });
    await prismaBase.saleReturn.create({ data: { saleId: sale.id, idempotencyKey: "del-ret-0001", tenantId: t } });

    await expect(deleteTenantData(t)).resolves.toMatchObject({ tenantId: t });
    expect(await prismaBase.sale.count({ where: { tenantId: t } })).toBe(0);
    expect(await prismaBase.tenant.findUnique({ where: { id: t } })).toBeNull();
  });
});

describe("misc guarantees", () => {
  it("a sale can be created by an OFFLINE user whose session was resolved in a fresh request (effective access is per request)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const w = await seedWorld();
    const u = await createTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(u.id, w.chA.id);
    await grantLocationAccess(u.id, w.whA.id);
    mockCookieStore.clear();
    await createSession(u.id);
    const id = await sell(w.chA.id, w.whA.id, w.product.id, 1);
    expect((await prisma.sale.findUniqueOrThrow({ where: { id } })).soldById).toBe(u.id);

    // revoking the channel takes effect on the very next resolution
    await prisma.userChannel.deleteMany({ where: { userId: u.id } });
    await expect(sell(w.chA.id, w.whA.id, w.product.id, 1)).rejects.toThrow(/non autorisé/i);
  });
});
