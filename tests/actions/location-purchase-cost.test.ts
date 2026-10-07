import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WcOrder } from "@/lib/integrations/woocommerce/types";
import { prisma } from "@/lib/prisma";
import {
  createStockTransferAction,
  dispatchStockTransferAction,
  receiveStockTransferAction,
} from "@/actions/transfers";
import { createReceptionAction, validateReceptionAction } from "@/actions/purchases";
import { createSaleAction } from "@/actions/sales";
import { createOrderAction } from "@/actions/orders";
import { updateTransferCostOverrideAction } from "@/actions/settings";
import { importOrder } from "@/lib/integrations/woocommerce/sync";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { getStoreProductPerformance } from "@/lib/analytics/queries/products";
import { getCurrentUser } from "@/lib/auth/session";
import { describeLocationCost, effectiveUnitCost } from "@/lib/catalog/location-cost";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Location purchase cost — Phase 2. One current purchase cost per
 * (location × product/variation) on InventoryItem.currentUnitCost; effective
 * cost = location → variation → product. Never a selling price.
 *
 * Scenario: global cost 100, Casablanca location cost 110, selling price 180,
 * 20 units in Casablanca → stock value 2 200, new store sale snapshot 110,
 * gross margin 70.
 */

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function setOverride(on: boolean, extra: Record<string, unknown> = {}) {
  await prisma.businessSettings.upsert({
    where: { tenantId: "default" },
    update: { transferPurchaseCostOverrideEnabled: on, ...extra },
    create: { transferPurchaseCostOverrideEnabled: on, ...extra },
  });
}

/** General Stock (default) with 20 units, Casablanca store sellable through an OFFLINE channel. */
async function seed(opts: { productCost?: number | null } = {}) {
  const general = await prisma.warehouse.create({ data: { name: "Stock général", isDefault: true } });
  const casa = await prisma.warehouse.create({ data: { name: "Magasin Casablanca", type: "MAGASIN" } });
  const channel = await prisma.salesChannel.create({ data: { name: "Caisse Casablanca", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: casa.id } });
  const product = await prisma.product.create({
    data: {
      name: "Sac cuir",
      sku: `SAC-${Math.random()}`,
      price: 180,
      cost: opts.productCost === undefined ? 100 : opts.productCost,
      status: "ACTIF",
    },
  });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
  const generalItem = await prisma.inventoryItem.create({ data: { warehouseId: general.id, productId: product.id, quantityOnHand: 20 } });
  return { general, casa, channel, product, generalItem };
}

/** A variable product with one variation stocked in General Stock. */
async function seedVariation(general: { id: string }, channelId: string, costs: { product: number | null; variation: number | null }) {
  const parent = await prisma.product.create({
    data: { name: "Polo", sku: `POLO-${Math.random()}`, price: 150, cost: costs.product, status: "ACTIF" },
  });
  const variation = await prisma.productVariation.create({
    data: { productId: parent.id, sku: `POLO-L-${Math.random()}`, attributes: { Taille: "L" }, price: 160, cost: costs.variation },
  });
  await prisma.productSalesChannel.create({ data: { productId: parent.id, salesChannelId: channelId } });
  await prisma.inventoryItem.create({ data: { warehouseId: general.id, variationId: variation.id, quantityOnHand: 10 } });
  return { parent, variation };
}

async function transfer(
  s: { general: { id: string }; casa: { id: string } },
  lines: { productId?: string | null; variationId?: string | null; quantitySent: number; destinationUnitCost?: number | null }[],
  received?: number[]
) {
  const created = await createStockTransferAction({
    sourceWarehouseId: s.general.id,
    destinationWarehouseId: s.casa.id,
    notes: "",
    lines: lines.map((l) => ({ productId: l.productId ?? null, variationId: l.variationId ?? null, quantitySent: l.quantitySent, ...(l.destinationUnitCost === undefined ? {} : { destinationUnitCost: l.destinationUnitCost }) })),
  });
  if (!created.ok) throw new Error(created.error);
  const d = await dispatchStockTransferAction({ id: created.data.id });
  if (!d.ok) throw new Error(d.error);
  const saved = await prisma.stockTransferLine.findMany({ where: { stockTransferId: created.data.id } });
  // Match each saved line to its input by reference (createMany order is not guaranteed).
  const qtyFor = (l: (typeof saved)[number]) => {
    const i = lines.findIndex((x) => (x.variationId ?? null) === l.variationId && (x.variationId ? true : (x.productId ?? null) === l.productId));
    return received ? received[i] : lines[i].quantitySent;
  };
  const r = await receiveStockTransferAction({ id: created.data.id, lines: saved.map((l) => ({ lineId: l.id, quantityReceived: qtyFor(l) })) });
  if (!r.ok) throw new Error(r.error);
  return created.data.id;
}

const casaItem = (casaId: string, ref: { productId?: string; variationId?: string }) =>
  prisma.inventoryItem.findFirstOrThrow({
    where: { warehouseId: casaId, ...(ref.variationId ? { variationId: ref.variationId } : { productId: ref.productId }) },
  });

async function sell(s: { casa: { id: string }; channel: { id: string } }, line: { productId?: string; variationId?: string; unitPrice: number }) {
  const r = await createSaleAction({
    salesChannelId: s.channel.id,
    warehouseId: s.casa.id,
    idempotencyKey: randomUUID(),
    lines: [{ ...line, quantity: 1 }],
    payments: [{ method: "ESPECES", amount: line.unitPrice }],
  });
  if (!r.ok) throw new Error(r.error);
  return prisma.sale.findUniqueOrThrow({ where: { id: r.data.id }, include: { lines: true } });
}

async function reception(supplierId: string, warehouseId: string, line: { productId?: string; variationId?: string; quantity: number; unitCost: number }) {
  const r = await createReceptionAction({ supplierId, warehouseId, lines: [line] });
  if (!r.ok) throw new Error(r.error);
  const v = await validateReceptionAction({ id: r.data.id });
  if (!v.ok) throw new Error(v.error);
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

describe("A/B/C — effective cost: location → variation → product", () => {
  it("pure fallback chain", () => {
    expect(num(effectiveUnitCost(110, 70, 100))).toBe(110);
    expect(num(effectiveUnitCost(null, 70, 100))).toBe(70); // B
    expect(num(effectiveUnitCost(null, null, 100))).toBe(100); // C
    expect(effectiveUnitCost(null, null, null)).toBeNull();
    expect(num(effectiveUnitCost(0, 70, 100))).toBe(0); // 0 is a real cost, not "missing"
    expect(describeLocationCost(110, null, 100).source).toBe("location");
    expect(describeLocationCost(null, null, 100).source).toBe("global");
    expect(describeLocationCost(null, null, null)).toEqual({ cost: null, source: null });
  });

  it("A — InventoryItem.currentUnitCost is nullable (default null) and the DB refuses a negative value", async () => {
    const s = await seed();
    expect(s.generalItem.currentUnitCost).toBeNull();
    await expect(prisma.inventoryItem.update({ where: { id: s.generalItem.id }, data: { currentUnitCost: -1 } })).rejects.toThrow();
  });
});

describe("the concrete scenario: 100 → Casablanca 110 → sale at 180", () => {
  it("stock value 2 200, store-sale snapshot 110, gross margin 70; General Stock and selling price untouched", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transfer(s, [{ productId: s.product.id, quantitySent: 20, destinationUnitCost: 110 }]);

    const item = await casaItem(s.casa.id, { productId: s.product.id });
    expect([item.quantityOnHand, num(item.currentUnitCost)]).toEqual([20, 110]);
    expect(num((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: s.generalItem.id } })).currentUnitCost)).toBeNull();

    // O — stock valuation per location
    const valuation = await getStockValuationReport();
    const casaRow = valuation.rows.find((r) => r.warehouseName === "Magasin Casablanca")!;
    expect([casaRow.quantityOnHand, casaRow.unitCost, casaRow.valueAtCost]).toEqual([20, 110, 2200]);

    // K — new store sale freezes the location cost; the VENTE movement records it
    const sale = await sell(s, { productId: s.product.id, unitPrice: 180 });
    expect(num(sale.lines[0].costSnapshot)).toBe(110);
    expect(num(sale.lines[0].unitPrice)).toBe(180);
    const vente = await prisma.inventoryMovement.findFirstOrThrow({ where: { saleId: sale.id, type: "VENTE" } });
    expect([vente.warehouseId, num(vente.unitCost)]).toEqual([s.casa.id, 110]);

    // gross margin through the existing store analytics (finance view)
    const user = await getCurrentUser();
    const perf = await getStoreProductPerformance(
      user!,
      { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) },
      {},
      { withFinance: true }
    );
    const row = perf.rows.find((r) => r.units === 1)!;
    expect([row.revenue, row.cogs, row.grossProfit]).toEqual([180, 110, 70]);

    // P — global cost and selling prices never move
    const product = await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } });
    expect([num(product.cost), num(product.price), product.salePrice]).toEqual([100, 180, null]);
  });
});

describe("transfers", () => {
  it("D — a transfer with destination cost sets the destination location cost; movement + line keep it", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const id = await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 110 }]);
    expect(num((await casaItem(s.casa.id, { productId: s.product.id })).currentUnitCost)).toBe(110);
    const entree = await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: id, type: "TRANSFERT_ENTREE" } });
    expect(num(entree.unitCost)).toBe(110);
    expect(num((await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: id } })).destinationUnitCost)).toBe(110);
  });

  it("E — a transfer WITHOUT destination cost keeps the destination's existing location cost", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 110 }]);
    await transfer(s, [{ productId: s.product.id, quantitySent: 5 }]);
    const item = await casaItem(s.casa.id, { productId: s.product.id });
    expect([item.quantityOnHand, num(item.currentUnitCost)]).toEqual([10, 110]);
  });

  it("E — never inherits the source location's cost", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await prisma.inventoryItem.update({ where: { id: s.generalItem.id }, data: { currentUnitCost: 130 } });
    await transfer(s, [{ productId: s.product.id, quantitySent: 5 }]);
    expect((await casaItem(s.casa.id, { productId: s.product.id })).currentUnitCost).toBeNull();
  });

  it("F — without destination cost and without location cost, Casablanca falls back to the global cost", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed(); // setting OFF
    await transfer(s, [{ productId: s.product.id, quantitySent: 5 }]);
    expect((await casaItem(s.casa.id, { productId: s.product.id })).currentUnitCost).toBeNull();
    const sale = await sell(s, { productId: s.product.id, unitPrice: 180 });
    expect(num(sale.lines[0].costSnapshot)).toBe(100);
    const valuation = await getStockValuationReport();
    expect(valuation.rows.find((r) => r.warehouseName === "Magasin Casablanca")?.unitCost).toBe(100);
  });

  it("G — mixed stock: last received cost wins for the whole location (no averaging); history untouched", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const first = await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 105 }]);
    await transfer(s, [{ productId: s.product.id, quantitySent: 15, destinationUnitCost: 110 }]);
    const item = await casaItem(s.casa.id, { productId: s.product.id });
    expect([item.quantityOnHand, num(item.currentUnitCost)]).toEqual([20, 110]);
    const old = await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: first, type: "TRANSFERT_ENTREE" } });
    expect(num(old.unitCost)).toBe(105);
  });

  it("R — partial receive sets the cost; a line received at 0 changes nothing at the destination", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const { variation } = await seedVariation(s.general, s.channel.id, { product: 60, variation: 70 });
    await transfer(
      s,
      [
        { productId: s.product.id, quantitySent: 10, destinationUnitCost: 110 },
        { variationId: variation.id, quantitySent: 4, destinationUnitCost: 80 },
      ],
      [3, 0]
    );
    const p = await casaItem(s.casa.id, { productId: s.product.id });
    expect([p.quantityOnHand, num(p.currentUnitCost)]).toEqual([3, 110]);
    expect(await prisma.inventoryItem.findFirst({ where: { warehouseId: s.casa.id, variationId: variation.id } })).toBeNull();
  });
});

describe("Q — variations", () => {
  it("variation location cost, then variation cost, then parent product cost", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const withCost = await seedVariation(s.general, s.channel.id, { product: 60, variation: 70 });
    const noCost = await seedVariation(s.general, s.channel.id, { product: 65, variation: null });
    await transfer(s, [
      { variationId: withCost.variation.id, quantitySent: 2, destinationUnitCost: 85 },
      { variationId: noCost.variation.id, quantitySent: 2 },
    ]);
    expect(num((await sell(s, { variationId: withCost.variation.id, unitPrice: 160 })).lines[0].costSnapshot)).toBe(85);
    expect(num((await sell(s, { variationId: noCost.variation.id, unitPrice: 160 })).lines[0].costSnapshot)).toBe(65);

    // a variation without location cost but with its own cost → variation cost
    await prisma.inventoryItem.updateMany({ where: { warehouseId: s.casa.id, variationId: withCost.variation.id }, data: { currentUnitCost: null } });
    expect(num((await sell(s, { variationId: withCost.variation.id, unitPrice: 160 })).lines[0].costSnapshot)).toBe(70);
    expect(num((await prisma.productVariation.findUniqueOrThrow({ where: { id: withCost.variation.id } })).cost)).toBe(70);
    expect(num((await prisma.productVariation.findUniqueOrThrow({ where: { id: withCost.variation.id } })).price)).toBe(160);
  });
});

describe("receptions", () => {
  it("H — feature ON: a reception sets the location cost (110 → 95); global cost follows the costing method as before", async () => {
    await setOverride(true); // costingMethod MANUAL
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 110 }]);
    const supplier = await prisma.supplier.create({ data: { name: "Fournisseur" } });
    await reception(supplier.id, s.casa.id, { productId: s.product.id, quantity: 4, unitCost: 95 });
    expect(num((await casaItem(s.casa.id, { productId: s.product.id })).currentUnitCost)).toBe(95);
    expect(num((await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } })).cost)).toBe(100); // MANUAL: global untouched
    expect(num((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: s.generalItem.id } })).currentUnitCost)).toBeNull();
  });

  it("H — feature ON with LAST_COST: location AND global costs both follow the reception", async () => {
    await setOverride(true, { costingMethod: "LAST_COST" });
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const supplier = await prisma.supplier.create({ data: { name: "Fournisseur" } });
    await reception(supplier.id, s.general.id, { productId: s.product.id, quantity: 4, unitCost: 92 });
    expect(num((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: s.generalItem.id } })).currentUnitCost)).toBe(92);
    expect(num((await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } })).cost)).toBe(92);
  });

  it("I — feature OFF: a reception never writes a location cost; existing costing behaviour unchanged", async () => {
    await setOverride(false, { costingMethod: "LAST_COST" });
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const supplier = await prisma.supplier.create({ data: { name: "Fournisseur" } });
    await reception(supplier.id, s.general.id, { productId: s.product.id, quantity: 4, unitCost: 92 });
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: s.generalItem.id } })).currentUnitCost).toBeNull();
    expect(num((await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } })).cost)).toBe(92);
    const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { type: "RECEPTION" } });
    expect(num(movement.unitCost)).toBe(92);
  });

  it("J — turning the setting off keeps recorded location costs, and they stay in use", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 110 }]);
    const f = new FormData();
    f.set("transferPurchaseCostOverrideEnabled", "false");
    expect((await updateTransferCostOverrideAction(f)).ok).toBe(true);

    expect(num((await casaItem(s.casa.id, { productId: s.product.id })).currentUnitCost)).toBe(110);
    const supplier = await prisma.supplier.create({ data: { name: "Fournisseur" } });
    await reception(supplier.id, s.casa.id, { productId: s.product.id, quantity: 1, unitCost: 95 }); // OFF → no write
    expect(num((await casaItem(s.casa.id, { productId: s.product.id })).currentUnitCost)).toBe(110);
    expect(num((await sell(s, { productId: s.product.id, unitPrice: 180 })).lines[0].costSnapshot)).toBe(110);
  });
});

describe("orders", () => {
  async function order(s: { product: { id: string } }, fulfillmentWarehouseId?: string) {
    const customer = await prisma.customer.create({ data: { fullName: "Client", phone: `06${Math.floor(Math.random() * 1e8)}` } });
    const r = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 0,
      currency: "MAD",
      ...(fulfillmentWarehouseId ? { fulfillmentWarehouseId } : {}),
      items: [{ productId: s.product.id, quantity: 1, unitPrice: 180, discount: 0 }],
    } as never);
    if (!r.ok) throw new Error(r.error);
    return prisma.order.findUniqueOrThrow({ where: { id: r.data.id }, include: { items: true } });
  }

  it("L — an ASODITECH order freezes the fulfilment warehouse's effective cost", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 110 }]);
    const fromCasa = await order(s, s.casa.id);
    expect([fromCasa.fulfillmentWarehouseId, num(fromCasa.items[0].costSnapshot), num(fromCasa.items[0].unitPrice)]).toEqual([s.casa.id, 110, 180]);
    const fromGeneral = await order(s); // default warehouse, no location cost → global
    expect([fromGeneral.fulfillmentWarehouseId, num(fromGeneral.items[0].costSnapshot)]).toEqual([s.general.id, 100]);
  });

  it("M — a WooCommerce import keeps the global cost even when the default warehouse has a location cost", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await prisma.product.update({ where: { id: s.product.id }, data: { source: "WOOCOMMERCE", externalId: "7701" } });
    await prisma.inventoryItem.update({ where: { id: s.generalItem.id }, data: { currentUnitCost: 120 } });
    const wc = {
      id: 9301, number: "9301", status: "pending", currency: "MAD", date_created: "2026-01-16T10:00:00", date_paid: null,
      customer_id: 0, total: 180, total_tax: 0, shipping_total: 0, discount_total: 0, payment_method: "cod",
      payment_method_title: null, customer_note: null,
      billing: { first_name: "Imp", last_name: "Ort", company: null, address_1: "x", address_2: null, city: "Rabat", state: null, postcode: null, country: "MA", email: "imp@example.com", phone: null },
      shipping: { first_name: "", last_name: "", company: null, address_1: "", address_2: null, city: "", state: null, postcode: null, country: "", email: null, phone: null },
      line_items: [{ id: 1, name: "Sac cuir", product_id: 7701, variation_id: null, sku: "SAC", quantity: 1, price: 180, subtotal: 180, total: 180, total_tax: 0 }],
      refunds: [],
    } as unknown as WcOrder;
    expect((await importOrder(wc, { type: "INTEGRATION" })).outcome).toBe("imported");
    const imported = await prisma.order.findFirstOrThrow({ where: { source: "WOOCOMMERCE", externalId: "9301" }, include: { items: true } });
    expect(num(imported.items[0].costSnapshot)).toBe(100);
  });
});

describe("N — history is never rewritten", () => {
  it("existing sale/order snapshots and movement costs keep their values after location costs change", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const first = await transfer(s, [{ productId: s.product.id, quantitySent: 10, destinationUnitCost: 110 }]);
    const sale = await sell(s, { productId: s.product.id, unitPrice: 180 });

    await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 125 }]);
    const supplier = await prisma.supplier.create({ data: { name: "Fournisseur" } });
    await reception(supplier.id, s.casa.id, { productId: s.product.id, quantity: 1, unitCost: 90 });

    expect(num((await prisma.saleLine.findFirstOrThrow({ where: { saleId: sale.id } })).costSnapshot)).toBe(110);
    expect(num((await prisma.inventoryMovement.findFirstOrThrow({ where: { saleId: sale.id } })).unitCost)).toBe(110);
    expect(num((await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: first, type: "TRANSFERT_ENTREE" } })).unitCost)).toBe(110);
    expect(num((await casaItem(s.casa.id, { productId: s.product.id })).currentUnitCost)).toBe(90);
    expect(num((await sell(s, { productId: s.product.id, unitPrice: 180 })).lines[0].costSnapshot)).toBe(90);
  });
});

describe("S — permissions", () => {
  it("a store seller never needs finance.view to sell; the snapshot still uses the location cost", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transfer(s, [{ productId: s.product.id, quantitySent: 5, destinationUnitCost: 110 }]);

    const { grantChannelAccess, grantLocationAccess } = await import("../helpers/auth");
    const seller = await loginAsTestUser({ role: "STORE_SELLER" });
    await grantLocationAccess(seller.id, [s.casa.id]);
    await grantChannelAccess(seller.id, [s.channel.id]);
    expect(num((await sell(s, { productId: s.product.id, unitPrice: 180 })).lines[0].costSnapshot)).toBe(110);
  });

  it("valuation hides every cost figure without cost access", async () => {
    await setOverride(true);
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    await transfer(s, [{ productId: s.product.id, quantitySent: 20, destinationUnitCost: 110 }]);
    const report = await getStockValuationReport({ includeCost: false });
    expect(report.rows.every((r) => r.unitCost === null && r.valueAtCost === null)).toBe(true);
  });
});
