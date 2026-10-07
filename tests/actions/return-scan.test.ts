import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { confirmPhysicalReturnAction, resolveReturnCodeAction } from "@/actions/returns";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { applyReturnScan, type ReturnScanLine } from "@/lib/returns/scan";
import { EXACT_CODE_MESSAGES } from "@/lib/catalog/exact-code";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Return dialogs' « Scanner » (online order + in-store sale): codes are resolved
 * by the shared exact resolver, applied to the dialog's lines, then submitted
 * through the UNCHANGED return actions — which keep their own ceilings,
 * idempotency, stock movements and audit.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** Catalogue: a simple product with a barcode, a T-shirt with Noir (barcode) / Blanc / Rouge variations. */
async function seedCatalog(warehouseId: string) {
  const cap = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50, status: "ACTIF" } });
  await prisma.barcode.create({ data: { code: "6100000000001", productId: cap.id, isPrimary: true } });
  const ts = await prisma.product.create({ data: { name: "T-shirt", sku: "TS-PARENT", price: 100, status: "ACTIF" } });
  const noir = await prisma.productVariation.create({ data: { productId: ts.id, sku: "TS-NOIR", attributes: { Couleur: "Noir" }, price: 100 } });
  const blanc = await prisma.productVariation.create({ data: { productId: ts.id, sku: "TS-BLANC", attributes: { Couleur: "Blanc" }, price: 100 } });
  const rouge = await prisma.productVariation.create({ data: { productId: ts.id, sku: "TS-ROUGE", attributes: { Couleur: "Rouge" }, price: 100 } });
  await prisma.barcode.create({ data: { code: "6100000000002", variationId: noir.id, isPrimary: true } });
  const other = await prisma.product.create({ data: { name: "Gourde", sku: "GRD-1", price: 30, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId, productId: cap.id, quantityOnHand: 10 } });
  for (const v of [noir, blanc, rouge]) await prisma.inventoryItem.create({ data: { warehouseId, variationId: v.id, quantityOnHand: 10 } });
  await prisma.inventoryItem.create({ data: { warehouseId, productId: other.id, quantityOnHand: 10 } });
  return { cap, ts, noir, blanc, rouge, other };
}

/** Shipped order: Casquette ×2, T-shirt Noir ×1, T-shirt Blanc ×1. */
async function shippedOrder() {
  const wh = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const cat = await seedCatalog(wh.id);
  const customer = await prisma.customer.create({ data: { fullName: "Client Retour" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod: "PAIEMENT_LIVRAISON",
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "",
    shippingAddressLine2: "",
    shippingCity: "",
    shippingRegion: "",
    shippingCountry: "",
    shippingPhone: "",
    items: [
      { productId: cat.cap.id, quantity: 2, unitPrice: 50, discount: 0 },
      { productId: null, variationId: cat.noir.id, quantity: 1, unitPrice: 100, discount: 0 },
      { productId: null, variationId: cat.blanc.id, quantity: 1, unitPrice: 100, discount: 0 },
    ],
  });
  if (!created.ok) throw new Error(created.error);
  for (const status of ["CONFIRMEE", "EN_PREPARATION", "EXPEDIEE"]) {
    const r = await updateOrderStatusAction(fd({ id: created.data.id, status }));
    if (!r.ok) throw new Error(r.error);
  }
  const order = await prisma.order.findUniqueOrThrow({ where: { id: created.data.id }, include: { items: true } });
  return { order, cat, wh };
}

/** The online dialog's lines, built exactly like the order page does (nothing returned yet). */
function orderLines(order: Awaited<ReturnType<typeof shippedOrder>>["order"], typed: Record<string, { s: number; d: number }> = {}): ReturnScanLine[] {
  return order.items.map((i) => ({
    id: i.id,
    label: i.nameSnapshot,
    productId: i.productId,
    variationId: i.variationId,
    remaining: i.quantity,
    sellable: typed[i.id]?.s ?? 0,
    damaged: typed[i.id]?.d ?? 0,
  }));
}

async function scan(code: string, scope: "order" | "sale" = "order") {
  const r = await resolveReturnCodeAction({ code, scope });
  if (!r.ok) return { resolved: false as const, error: r.error };
  return { resolved: true as const, unit: r.data };
}

describe("resolveReturnCodeAction — shared exact resolver", () => {
  it("exact simple barcode / variation barcode / SKU resolve; unknown and ambiguous do not", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const wh = await prisma.warehouse.create({ data: { name: "E", isDefault: true } });
    const cat = await seedCatalog(wh.id);
    expect(await scan("6100000000001")).toMatchObject({ resolved: true, unit: { productId: cat.cap.id, variationId: null, label: "Casquette" } });
    expect(await scan("6100000000002")).toMatchObject({ resolved: true, unit: { variationId: cat.noir.id, label: "T-shirt — Noir" } });
    expect(await scan("ts-blanc")).toMatchObject({ resolved: true, unit: { variationId: cat.blanc.id } });
    expect(await scan("CAP-1")).toMatchObject({ resolved: true, unit: { productId: cat.cap.id } });
    expect(await scan("UNKNOWN")).toEqual({ resolved: false, error: EXACT_CODE_MESSAGES.notFound });
    expect(await scan("TS-PARENT")).toEqual({ resolved: false, error: EXACT_CODE_MESSAGES.ambiguous });
    expect(await scan("Casquette")).toEqual({ resolved: false, error: EXACT_CODE_MESSAGES.notFound }); // no fuzzy
  });

  it("needs the return permission of its scope", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" }); // no orders.return / sales.return
    await expect(resolveReturnCodeAction({ code: "X", scope: "order" })).rejects.toThrow(/non autoris/i);
    await expect(resolveReturnCodeAction({ code: "X", scope: "sale" })).rejects.toThrow(/non autoris/i);
  });
});

describe("online order return — scan then the unchanged confirmPhysicalReturnAction", () => {
  it("scans fill the right lines within limits; the server return still applies stock, ceilings and idempotency", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { order, cat } = await shippedOrder();
    const capItem = order.items.find((i) => i.productId === cat.cap.id)!;
    const noirItem = order.items.find((i) => i.variationId === cat.noir.id)!;
    const typed: Record<string, { s: number; d: number }> = {};
    const apply = async (code: string) => {
      const r = await scan(code);
      if (!r.resolved) return { ok: false as const, error: r.error };
      const res = applyReturnScan(orderLines(order, typed), r.unit, "commande");
      if (res.ok) typed[res.lineId] = { s: res.sellable, d: typed[res.lineId]?.d ?? 0 };
      return res;
    };

    expect(await apply("6100000000001")).toMatchObject({ ok: true, lineId: capItem.id, sellable: 1 }); // simple barcode
    expect(await apply("CAP-1")).toMatchObject({ ok: true, lineId: capItem.id, sellable: 2 }); // SKU, same line
    expect(await apply("CAP-1")).toMatchObject({ ok: false, error: expect.stringMatching(/maximale/) }); // ceiling (2)
    expect(await apply("6100000000002")).toMatchObject({ ok: true, lineId: noirItem.id, sellable: 1 }); // variation barcode
    expect(await apply("TS-ROUGE")).toMatchObject({ ok: false, error: expect.stringMatching(/variante/) }); // variation not in order
    expect(await apply("GRD-1")).toMatchObject({ ok: false, error: expect.stringMatching(/ne fait pas partie/) }); // product from elsewhere
    expect(await apply("UNKNOWN")).toMatchObject({ ok: false }); // unknown: nothing changed
    expect(await apply("TS-PARENT")).toMatchObject({ ok: false }); // ambiguous: nothing changed
    expect(typed).toEqual({ [capItem.id]: { s: 2, d: 0 }, [noirItem.id]: { s: 1, d: 0 } });

    // Operator moves 1 Casquette to « endommagé » by hand, then submits through the unchanged action.
    typed[capItem.id] = { s: 1, d: 1 };
    const key = randomUUID();
    const submit = () =>
      confirmPhysicalReturnAction({
        orderId: order.id,
        idempotencyKey: key,
        lines: Object.entries(typed).map(([orderItemId, q]) => ({ orderItemId, quantitySellable: q.s, quantityDamaged: q.d })),
      });
    expect((await submit()).ok).toBe(true);
    expect((await submit()).ok).toBe(true); // same key → idempotent, nothing applied twice
    expect(await prisma.orderReturn.count({ where: { orderId: order.id } })).toBe(1);
    const capStock = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: cat.cap.id } });
    expect([capStock.quantityOnHand, capStock.quantityDamaged]).toEqual([9, 1]); // 10 − 2 shipped + 1 sellable; 1 damaged parked
    const noirStock = await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: cat.noir.id } });
    expect(noirStock.quantityOnHand).toBe(10); // 10 − 1 + 1
    expect(await prisma.auditEvent.count({ where: { action: "order.return_confirmed", entityId: order.id } })).toBe(1);

    // The Casquette line is now fully returned: a new scan is refused, and the server ceiling still holds.
    const afterLines = orderLines(order).map((l) => (l.id === capItem.id ? { ...l, remaining: 0 } : l.id === noirItem.id ? { ...l, remaining: 0 } : l));
    const again = await scan("CAP-1");
    expect(again.resolved && applyReturnScan(afterLines, again.unit, "commande")).toEqual({
      ok: false,
      error: "« Casquette » a déjà été entièrement retourné.",
    });
    const overflow = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: capItem.id, quantitySellable: 1, quantityDamaged: 0 }],
    });
    expect(overflow.ok).toBe(false);
  });
});

describe("in-store sale return — scan then the unchanged createSaleReturnAction", () => {
  it("scans fill the sale's lines within limits; the server return keeps its guarantees", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "ADMIN" });
    const store = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });
    const channel = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
    const cat = await seedCatalog(store.id);
    for (const p of [cat.cap, cat.ts, cat.other]) await prisma.productSalesChannel.create({ data: { productId: p.id, salesChannelId: channel.id } });

    const sold = await createSaleAction({
      salesChannelId: channel.id,
      warehouseId: store.id,
      idempotencyKey: randomUUID(),
      lines: [
        { productId: cat.cap.id, quantity: 1 },
        { variationId: cat.noir.id, quantity: 2 },
      ],
      payments: [{ method: "ESPECES", amount: 250 }],
    });
    if (!sold.ok) throw new Error(sold.error);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: sold.data.id }, include: { lines: true } });
    const qty: Record<string, { s: number; d: number }> = {};
    const lines = (): ReturnScanLine[] =>
      sale.lines.map((l) => ({
        id: l.id,
        label: l.nameSnapshot,
        productId: l.productId,
        variationId: l.variationId,
        remaining: l.quantity,
        sellable: qty[l.id]?.s ?? 0,
        damaged: qty[l.id]?.d ?? 0,
      }));
    const apply = async (code: string) => {
      const r = await scan(code, "sale");
      if (!r.resolved) return { ok: false as const, error: r.error };
      const res = applyReturnScan(lines(), r.unit, "vente");
      if (res.ok) qty[res.lineId] = { s: res.sellable, d: qty[res.lineId]?.d ?? 0 };
      return res;
    };
    const noirLine = sale.lines.find((l) => l.variationId === cat.noir.id)!;

    expect(await apply("6100000000002")).toMatchObject({ ok: true, lineId: noirLine.id, sellable: 1 });
    expect(await apply("TS-NOIR")).toMatchObject({ ok: true, lineId: noirLine.id, sellable: 2 });
    expect(await apply("TS-NOIR")).toMatchObject({ ok: false }); // 2 sold
    expect(await apply("TS-BLANC")).toMatchObject({ ok: false, error: expect.stringMatching(/variante.*vente/) });
    expect(await apply("GRD-1")).toMatchObject({ ok: false, error: expect.stringMatching(/ne fait pas partie de cette vente/) });

    const r = await createSaleReturnAction({
      saleId: sale.id,
      idempotencyKey: randomUUID(),
      lines: Object.entries(qty).map(([saleLineId, q]) => ({ saleLineId, quantitySellable: q.s, quantityDamaged: q.d })),
      refundAmount: 0,
      refundMethod: null,
      note: "",
    });
    expect(r.ok).toBe(true);
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: cat.noir.id } })).quantityOnHand).toBe(10); // 10 − 2 + 2
    expect(await prisma.auditEvent.count({ where: { action: "sale.return_created" } })).toBe(1);
  });
});
