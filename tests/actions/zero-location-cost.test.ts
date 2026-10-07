import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createStockTransferAction, dispatchStockTransferAction, receiveStockTransferAction } from "@/actions/transfers";
import { createReceptionAction, validateReceptionAction } from "@/actions/purchases";
import { updateLocationCostAction } from "@/actions/inventory";
import { createSaleAction } from "@/actions/sales";
import { createOrderAction } from "@/actions/orders";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * A location purchase cost of 0 is a REAL cost (free goods, samples) — never
 * "missing". It must never fall back to the variation or product cost, at any
 * step: transfer, receive, reception, manual edit, valuation, store sale and
 * its movement, ASODITECH order.
 */

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function seed() {
  await prisma.businessSettings.create({ data: { transferPurchaseCostOverrideEnabled: true } });
  const general = await prisma.warehouse.create({ data: { name: "Stock général", isDefault: true } });
  const casa = await prisma.warehouse.create({ data: { name: "Magasin Casablanca", type: "MAGASIN" } });
  const channel = await prisma.salesChannel.create({ data: { name: "Caisse Casablanca", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: casa.id } });
  const product = await prisma.product.create({ data: { name: "Échantillon", sku: `ECH-${Math.random()}`, price: 50, cost: 100, status: "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
  await prisma.inventoryItem.create({ data: { warehouseId: general.id, productId: product.id, quantityOnHand: 20 } });
  return { general, casa, channel, product };
}

const casaItem = (s: { casa: { id: string }; product: { id: string } }) =>
  prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.casa.id, productId: s.product.id } });

async function transferAtZero(s: Awaited<ReturnType<typeof seed>>, qty = 10) {
  const created = await createStockTransferAction({
    sourceWarehouseId: s.general.id,
    destinationWarehouseId: s.casa.id,
    notes: "",
    lines: [{ productId: s.product.id, variationId: null, quantitySent: qty, destinationUnitCost: 0 }],
  });
  if (!created.ok) throw new Error(created.error);
  await dispatchStockTransferAction({ id: created.data.id });
  const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: created.data.id } });
  const r = await receiveStockTransferAction({ id: created.data.id, lines: [{ lineId: line.id, quantityReceived: qty }] });
  if (!r.ok) throw new Error(r.error);
  return { transferId: created.data.id, line };
}

async function sell(s: Awaited<ReturnType<typeof seed>>) {
  const r = await createSaleAction({
    salesChannelId: s.channel.id,
    warehouseId: s.casa.id,
    idempotencyKey: randomUUID(),
    lines: [{ productId: s.product.id, quantity: 1 }],
    payments: [{ method: "ESPECES", amount: 50 }],
  });
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("zero location purchase cost is a real cost", () => {
  it("1/2 — transfer creation records 0; receive sets the location cost and the movement to 0", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const { transferId, line } = await transferAtZero(s);
    expect(num(line.destinationUnitCost)).toBe(0);
    expect(num((await casaItem(s)).currentUnitCost)).toBe(0);
    const entree = await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: transferId, type: "TRANSFERT_ENTREE" } });
    expect(entree.unitCost).not.toBeNull();
    expect(num(entree.unitCost)).toBe(0);
  });

  it("3 — a reception at 0 (feature ON) sets the location cost to 0", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await prisma.inventoryItem.create({ data: { warehouseId: s.casa.id, productId: s.product.id, quantityOnHand: 0, currentUnitCost: 110 } });
    const supplier = await prisma.supplier.create({ data: { name: "Fournisseur" } });
    const rec = await createReceptionAction({ supplierId: supplier.id, warehouseId: s.casa.id, lines: [{ productId: s.product.id, quantity: 5, unitCost: 0 }] });
    if (!rec.ok) throw new Error(rec.error);
    expect((await validateReceptionAction({ id: rec.data.id })).ok).toBe(true);
    const item = await casaItem(s);
    expect(item.currentUnitCost).not.toBeNull();
    expect(num(item.currentUnitCost)).toBe(0);
  });

  it("4/5 — manual edit to 0 stores 0; clearing afterwards falls back to the global cost", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const item = await prisma.inventoryItem.create({ data: { warehouseId: s.casa.id, productId: s.product.id, quantityOnHand: 5 } });
    expect(await updateLocationCostAction({ inventoryItemId: item.id, cost: 0 })).toMatchObject({ ok: true, data: { cost: "0" } });
    expect(num((await casaItem(s)).currentUnitCost)).toBe(0);
    expect(num((await prisma.saleLine.findFirstOrThrow({ where: { saleId: await sell(s) } })).costSnapshot)).toBe(0);

    expect((await updateLocationCostAction({ inventoryItemId: item.id, cost: null })).ok).toBe(true);
    expect((await casaItem(s)).currentUnitCost).toBeNull();
    expect(num((await prisma.saleLine.findFirstOrThrow({ where: { saleId: await sell(s) } })).costSnapshot)).toBe(100);
  });

  it("6/7 — stock valuation values a 0-cost location at 0 (not 100, not 'missing')", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transferAtZero(s, 10);
    const report = await getStockValuationReport();
    const row = report.rows.find((r) => r.warehouseName === "Magasin Casablanca")!;
    expect([row.unitCost, row.valueAtCost]).toEqual([0, 0]);
    const general = report.rows.find((r) => r.warehouseName === "Stock général")!;
    expect([general.quantityOnHand, general.unitCost, general.valueAtCost]).toEqual([10, 100, 1000]);
    expect(report.totals.linesMissingCost).toBe(0);
    expect(report.totals.valueAtCost).toBe(1000);
  });

  it("6 — a 0 location cost wins over a variation cost too", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const v = await prisma.productVariation.create({
      data: { productId: s.product.id, sku: `ECH-V-${Math.random()}`, attributes: { Taille: "U" }, price: 60, cost: 80 },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: s.casa.id, variationId: v.id, quantityOnHand: 3, currentUnitCost: 0 } });
    const row = (await getStockValuationReport()).rows.find((r) => r.sku === v.sku)!;
    expect([row.unitCost, row.valueAtCost]).toEqual([0, 0]);
  });

  it("8/9 — a store sale freezes a 0 snapshot and records 0 on its stock movement", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transferAtZero(s);
    const saleId = await sell(s);
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId } });
    expect(line.costSnapshot).not.toBeNull();
    expect(num(line.costSnapshot)).toBe(0);
    const vente = await prisma.inventoryMovement.findFirstOrThrow({ where: { saleId, type: "VENTE" } });
    expect(vente.unitCost).not.toBeNull();
    expect(num(vente.unitCost)).toBe(0);
  });

  it("10 — an ASODITECH order fulfilled from the 0-cost location snapshots 0", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transferAtZero(s);
    const customer = await prisma.customer.create({ data: { fullName: "Client", phone: "0600000009" } });
    const r = await createOrderAction({
      customerId: customer.id, paymentMethod: "PAIEMENT_LIVRAISON", shippingCost: 0, discountTotal: 0, currency: "MAD",
      fulfillmentWarehouseId: s.casa.id,
      items: [{ productId: s.product.id, quantity: 1, unitPrice: 50, discount: 0 }],
    } as never);
    if (!r.ok) throw new Error(r.error);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: r.data.id } });
    expect(item.costSnapshot).not.toBeNull();
    expect(num(item.costSnapshot)).toBe(0);
  });
});
