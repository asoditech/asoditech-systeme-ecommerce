import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createSaleAction, createSaleReturnAction, lookupForSaleAction } from "@/actions/sales";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { confirmPhysicalReturnAction } from "@/actions/returns";
import { getCurrentUser } from "@/lib/auth/session";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantLocationAccess, grantChannelAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Offline (in-store) sales — Phase F (docs/adr/0040). One physical stock, the
 * canonical movement primitive, available-stock validation, atomicity,
 * idempotency, returns. Also proves the Online lifecycle is untouched.
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

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** A store channel + location + one product stocked and enabled there. */
async function seedStore(opts: { onHand?: number; reserved?: number; price?: number; sku?: string } = {}) {
  const store = await prisma.warehouse.create({ data: { name: "Boutique Casa", type: "MAGASIN", isDefault: true } });
  const channel = await prisma.salesChannel.create({ data: { name: "Magasin Casablanca", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
  const product = await prisma.product.create({
    data: { name: "Basket", sku: opts.sku ?? "BASKET-1", price: opts.price ?? 300, status: "ACTIF", cost: 120 },
  });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
  const item = await prisma.inventoryItem.create({
    data: { warehouseId: store.id, productId: product.id, quantityOnHand: opts.onHand ?? 10, quantityReserved: opts.reserved ?? 0 },
  });
  return { store, channel, product, item };
}

const sale = (
  ctx: { channel: { id: string }; store: { id: string } },
  lines: { productId?: string; variationId?: string; quantity: number; unitPrice?: number; discount?: number }[],
  payments: { method: "ESPECES" | "CARTE"; amount: number }[],
  key: string = randomUUID()
) => ({ salesChannelId: ctx.channel.id, warehouseId: ctx.store.id, idempotencyKey: key, lines, payments });

const stock = async (itemId: string) => prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId } });

describe("successful sale", () => {
  it("decrements physical stock ONCE via a VENTE movement; records payment, actor, time, snapshots and numbering", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10 });

    const r = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 2 }], [{ method: "ESPECES", amount: 600 }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.duplicate).toBe(false);

    expect((await stock(ctx.item.id)).quantityOnHand).toBe(8);
    const movements = await prisma.inventoryMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      type: "VENTE",
      quantity: 2,
      onHandDelta: -2,
      onHandAfter: 8,
      saleId: r.data.id,
      warehouseId: ctx.store.id,
      performedById: admin.id,
    });

    const s = await prisma.sale.findUniqueOrThrow({ where: { id: r.data.id }, include: { lines: true, payments: true } });
    expect([Number(s.subtotal), Number(s.total), s.displayNumber]).toEqual([600, 600, 1]);
    expect(s.soldById).toBe(admin.id);
    expect(s.soldByName).toBe(admin.name);
    expect(s.soldAt).toBeInstanceOf(Date);
    expect(s.salesChannelId).toBe(ctx.channel.id);
    expect(s.lines[0]).toMatchObject({ nameSnapshot: "Basket", skuSnapshot: "BASKET-1", quantity: 2 });
    expect(Number(s.lines[0].costSnapshot)).toBe(120);
    expect(s.payments.map((p) => [p.method, Number(p.amount)])).toEqual([["ESPECES", 600]]);
    expect(await prisma.auditEvent.count({ where: { action: "sale.created", actorUserId: admin.id } })).toBe(1);
  });

  it("split payments are recorded and must add up to the total exactly", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore();
    const bad = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 100 }]));
    expect(bad.ok).toBe(false);
    expect(await prisma.sale.count()).toBe(0);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(10);

    const ok = await createSaleAction(
      sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 100 }, { method: "CARTE", amount: 200 }])
    );
    expect(ok.ok).toBe(true);
    expect(await prisma.salePayment.count()).toBe(2);
  });

  it("a barcode scan resolves to the variation, and the sale decrements that variation's own stock row", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const store = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });
    const channel = await prisma.salesChannel.create({ data: { name: "Magasin A", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
    const parent = await prisma.product.create({ data: { name: "Adidas SKOUBA", sku: "SKOUBA", price: 500, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: parent.id, salesChannelId: channel.id } });
    const v42 = await prisma.productVariation.create({ data: { productId: parent.id, sku: "SKOUBA-B-42", attributes: { Couleur: "Bleu", Taille: "42" } } });
    const v43 = await prisma.productVariation.create({ data: { productId: parent.id, sku: "SKOUBA-B-43", attributes: { Couleur: "Bleu", Taille: "43" } } });
    await prisma.barcode.create({ data: { code: "6111111111142", variationId: v42.id, isPrimary: true } });
    const i42 = await prisma.inventoryItem.create({ data: { warehouseId: store.id, variationId: v42.id, quantityOnHand: 5 } });
    const i43 = await prisma.inventoryItem.create({ data: { warehouseId: store.id, variationId: v43.id, quantityOnHand: 5 } });

    const hits = await lookupForSaleAction({ query: "6111111111142", salesChannelId: channel.id, warehouseId: store.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ available: 5, tracked: true });
    expect(hits[0].unit.variationId).toBe(v42.id);

    const r = await createSaleAction({
      salesChannelId: channel.id,
      warehouseId: store.id,
      idempotencyKey: randomUUID(),
      lines: [{ variationId: hits[0].unit.variationId!, quantity: 2 }],
      payments: [{ method: "ESPECES", amount: 1000 }],
    });
    expect(r.ok).toBe(true);
    expect((await stock(i42.id)).quantityOnHand).toBe(3);
    expect((await stock(i43.id)).quantityOnHand).toBe(5); // siblings untouched
  });
});

describe("stock safety — available, not merely on-hand", () => {
  it("cannot consume stock RESERVED for a confirmed online order — fails atomically, nothing created", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10, reserved: 8 }); // available = 2
    const r = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 3 }], [{ method: "ESPECES", amount: 900 }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/insuffisant/i);

    const after = await stock(ctx.item.id);
    expect([after.quantityOnHand, after.quantityReserved]).toEqual([10, 8]);
    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.salePayment.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("can sell exactly the available quantity, and the reservation is untouched", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10, reserved: 8 });
    const r = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 2 }], [{ method: "ESPECES", amount: 600 }]));
    expect(r.ok).toBe(true);
    const after = await stock(ctx.item.id);
    expect([after.quantityOnHand, after.quantityReserved]).toEqual([8, 8]);
  });

  it("on-hand can never go negative", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 2 });
    const r = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 3 }], [{ method: "ESPECES", amount: 900 }]));
    expect(r.ok).toBe(false);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(2);
  });

  it("a unit with NO stock row at the location is a controlled error — never silently treated as zero", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore();
    const untracked = await prisma.product.create({ data: { name: "Écharpe", sku: "ECH-1", price: 50, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: untracked.id, salesChannelId: ctx.channel.id } });
    // No InventoryItem for `untracked` at the store.
    const r = await createSaleAction(sale(ctx, [{ productId: untracked.id, quantity: 1 }], [{ method: "ESPECES", amount: 50 }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n'est pas suivi en stock/i);
    expect(await prisma.sale.count()).toBe(0);
  });

  it("is ATOMIC: when the 2nd line fails, the 1st line's decrement is rolled back too", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10 });
    const scarce = await prisma.product.create({ data: { name: "Rare", sku: "RARE-1", price: 100, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: scarce.id, salesChannelId: ctx.channel.id } });
    const rareItem = await prisma.inventoryItem.create({ data: { warehouseId: ctx.store.id, productId: scarce.id, quantityOnHand: 1 } });

    const r = await createSaleAction(
      sale(
        ctx,
        [{ productId: ctx.product.id, quantity: 4 }, { productId: scarce.id, quantity: 5 }],
        [{ method: "ESPECES", amount: 1700 }]
      )
    );
    expect(r.ok).toBe(false);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(10); // 1st line NOT left decremented
    expect((await stock(rareItem.id)).quantityOnHand).toBe(1);
    expect(await prisma.inventoryMovement.count()).toBe(0);
    expect(await prisma.sale.count()).toBe(0);
  });
});

describe("idempotency", () => {
  it("the same key submitted repeatedly — or concurrently — creates ONE sale and decrements ONCE", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10 });
    const key = randomUUID();
    const payload = sale(ctx, [{ productId: ctx.product.id, quantity: 3 }], [{ method: "ESPECES", amount: 900 }], key);

    const results = await Promise.all([createSaleAction(payload), createSaleAction(payload), createSaleAction(payload)]);
    expect(results.every((r) => r.ok)).toBe(true);
    const again = await createSaleAction(payload);
    expect(again.ok && again.data.duplicate).toBe(true);

    const ids = new Set(results.map((r) => (r.ok ? r.data.id : "")));
    expect(ids.size).toBe(1);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(7);
    expect(await prisma.sale.count()).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { type: "VENTE" } })).toBe(1);
    expect(await prisma.salePayment.count()).toBe(1);
  });

  it("two DIFFERENT keys are two sales", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10 });
    await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 300 }]));
    await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 300 }]));
    expect(await prisma.sale.count()).toBe(2);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(8);
  });

  it("concurrent DIFFERENT sales can never oversell (row-locked): 5 units, three sales of 2", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 5 });
    const results = await Promise.all(
      [0, 1, 2].map(() => createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 2 }], [{ method: "ESPECES", amount: 600 }])))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(1);
  });
});

describe("price rules", () => {
  it("the SERVER price is used when none is sent; a different price/discount needs sales.override_price", async () => {
    const seller = await loginAsTestUser({ role: "WAREHOUSE", channels: "none" });
    const ctx = await seedStore({ price: 300 });
    await grantChannelAccess(seller.id, ctx.channel.id);
    await grantLocationAccess(seller.id, ctx.store.id);
    await prisma.userPermissionOverride.create({ data: { userId: seller.id, permission: "sales.create", effect: "GRANT" } });

    // no price sent → catalogue price 300
    const ok = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 300 }]));
    expect(ok.ok).toBe(true);

    // a cheaper price → refused for this seller
    const cheaper = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1, unitPrice: 100 }], [{ method: "ESPECES", amount: 100 }]));
    expect(cheaper.ok).toBe(false);
    const discounted = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1, discount: 50 }], [{ method: "ESPECES", amount: 250 }]));
    expect(discounted.ok).toBe(false);

    // once granted the override permission, both are allowed
    await prisma.userPermissionOverride.create({ data: { userId: seller.id, permission: "sales.override_price", effect: "GRANT" } });
    expect((await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1, unitPrice: 100 }], [{ method: "ESPECES", amount: 100 }]))).ok).toBe(true);
    expect((await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1, discount: 50 }], [{ method: "ESPECES", amount: 250 }]))).ok).toBe(true);
  });

  it("a discount larger than the line is rejected", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ price: 100 });
    const r = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1, discount: 500 }], [{ method: "ESPECES", amount: 0.01 }]));
    expect(r.ok).toBe(false);
  });
});

describe("channel, location and catalogue boundaries", () => {
  it("only an OFFLINE channel mapped to the chosen location can sell from it", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore();
    const online = await ensureDefaultOnlineChannel();
    const other = await prisma.warehouse.create({ data: { name: "Autre boutique", type: "MAGASIN" } });
    const inactive = await prisma.salesChannel.create({ data: { name: "Fermé", kind: "OFFLINE", isActive: false } });

    const p = [{ productId: ctx.product.id, quantity: 1 }];
    const pay = [{ method: "ESPECES" as const, amount: 300 }];
    expect((await createSaleAction({ salesChannelId: online.id, warehouseId: ctx.store.id, idempotencyKey: randomUUID(), lines: p, payments: pay })).ok).toBe(false); // ONLINE channel
    expect((await createSaleAction({ salesChannelId: ctx.channel.id, warehouseId: other.id, idempotencyKey: randomUUID(), lines: p, payments: pay })).ok).toBe(false); // not mapped
    expect((await createSaleAction({ salesChannelId: inactive.id, warehouseId: ctx.store.id, idempotencyKey: randomUUID(), lines: p, payments: pay })).ok).toBe(false); // inactive
    expect((await createSaleAction({ salesChannelId: "nope", warehouseId: ctx.store.id, idempotencyKey: randomUUID(), lines: p, payments: pay })).ok).toBe(false);
    expect(await prisma.sale.count()).toBe(0);
  });

  it("a product not enabled on the channel, a variable parent and an archived product cannot be sold", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore();
    const notOnChannel = await prisma.product.create({ data: { name: "Online seul", sku: "ONL-1", price: 10, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: ctx.store.id, productId: notOnChannel.id, quantityOnHand: 5 } });
    const parent = await prisma.product.create({ data: { name: "Parent", sku: "PAR", price: 10, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: parent.id, salesChannelId: ctx.channel.id } });
    await prisma.productVariation.create({ data: { productId: parent.id, sku: "PAR-1", attributes: {} } });
    const archived = await prisma.product.create({ data: { name: "Vieux", sku: "OLD", price: 10, status: "ARCHIVE" } });
    await prisma.productSalesChannel.create({ data: { productId: archived.id, salesChannelId: ctx.channel.id } });

    for (const productId of [notOnChannel.id, parent.id, archived.id]) {
      const r = await createSaleAction(sale(ctx, [{ productId, quantity: 1 }], [{ method: "ESPECES", amount: 10 }]));
      expect(r.ok).toBe(false);
    }
  });

  it("a seller assigned to Store A cannot sell on Store B's channel; and a seller without location access is refused", async () => {
    const ctxA = await seedStore({ sku: "A-1" });
    const storeB = await prisma.warehouse.create({ data: { name: "Boutique B", type: "MAGASIN" } });
    const channelB = await prisma.salesChannel.create({ data: { name: "Magasin B", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channelB.id, warehouseId: storeB.id } });

    const seller = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(seller.id, ctxA.channel.id);
    const payload = sale(ctxA, [{ productId: ctxA.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 300 }]);

    // channel OK, but no location access yet
    await expect(createSaleAction(payload)).rejects.toThrow(/non autorisé/i);
    await grantLocationAccess(seller.id, ctxA.store.id);
    expect((await createSaleAction(payload)).ok).toBe(true);

    // Store B: not assigned
    await grantLocationAccess(seller.id, storeB.id);
    await expect(
      createSaleAction({ salesChannelId: channelB.id, warehouseId: storeB.id, idempotencyKey: randomUUID(), lines: [{ productId: ctxA.product.id, quantity: 1 }], payments: [{ method: "ESPECES", amount: 300 }] })
    ).rejects.toThrow(/non autorisé/i);
  });

  it("an ONLINE-only user has no sales.create at all — direct action access is refused", async () => {
    await loginAsTestUser({ role: "MANAGER" }); // default ONLINE channel only
    const ctx = await seedStore();
    await expect(
      createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 300 }]))
    ).rejects.toThrow(/non autorisé/i);
    expect(await prisma.sale.count()).toBe(0);
  });

  it("tenant isolation: tenant B's channel, warehouse and product are unreachable from tenant A", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await prismaBase.tenant.create({ data: { id: "tenant-b-sales", name: "B", slug: "tenant-b-sales" } });
    const whB = await prismaBase.warehouse.create({ data: { name: "WB", type: "MAGASIN", tenantId: "tenant-b-sales" } });
    const chB = await prismaBase.salesChannel.create({ data: { name: "Magasin B", kind: "OFFLINE", tenantId: "tenant-b-sales" } });
    await prismaBase.salesChannelLocation.create({ data: { salesChannelId: chB.id, warehouseId: whB.id, tenantId: "tenant-b-sales" } });
    const pB = await prismaBase.product.create({ data: { name: "PB", sku: "PB", price: 5, status: "ACTIF", tenantId: "tenant-b-sales" } });
    await prismaBase.productSalesChannel.create({ data: { productId: pB.id, salesChannelId: chB.id, tenantId: "tenant-b-sales" } });
    await prismaBase.inventoryItem.create({ data: { warehouseId: whB.id, productId: pB.id, quantityOnHand: 9, tenantId: "tenant-b-sales" } });

    const r = await createSaleAction({
      salesChannelId: chB.id,
      warehouseId: whB.id,
      idempotencyKey: randomUUID(),
      lines: [{ productId: pB.id, quantity: 1 }],
      payments: [{ method: "ESPECES", amount: 5 }],
    });
    expect(r.ok).toBe(false);
    expect((await prismaBase.inventoryItem.findFirstOrThrow({ where: { productId: pB.id } })).quantityOnHand).toBe(9);
    expect(await prismaBase.sale.count({ where: { tenantId: "tenant-b-sales" } })).toBe(0);
  });
});

describe("sale returns", () => {
  async function soldOnce(quantity = 4) {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10 });
    const r = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity }], [{ method: "ESPECES", amount: 300 * quantity }]));
    if (!r.ok) throw new Error("setup: " + r.error);
    const s = await prisma.sale.findUniqueOrThrow({ where: { id: r.data.id }, include: { lines: true } });
    return { admin, ctx, sale: s, line: s.lines[0] };
  }
  const ret = (saleId: string, saleLineId: string, sellable: number, damaged = 0, extra: Record<string, unknown> = {}) => ({
    saleId,
    idempotencyKey: randomUUID(),
    lines: [{ saleLineId, quantitySellable: sellable, quantityDamaged: damaged }],
    ...extra,
  });

  it("credits ONLY sellable units to on-hand; damaged units go to quantityDamaged and never to on-hand", async () => {
    const { ctx, sale: s, line, admin } = await soldOnce(4); // stock 10 → 6
    const r = await createSaleReturnAction(ret(s.id, line.id, 2, 1, { refundAmount: 900, refundMethod: "ESPECES" }));
    expect(r.ok).toBe(true);

    const after = await stock(ctx.item.id);
    expect([after.quantityOnHand, after.quantityDamaged]).toEqual([8, 1]); // 6 + 2 sellable; 1 damaged parked

    const movements = await prisma.inventoryMovement.findMany({ where: { saleReturnId: { not: null } }, orderBy: { createdAt: "asc" } });
    expect(movements.map((m) => [m.type, m.quantity, m.onHandDelta])).toEqual([["RETOUR", 2, 2], ["ENDOMMAGE", 1, 0]]);
    expect(movements.every((m) => m.saleId === s.id && m.performedById === admin.id)).toBe(true);

    const sr = await prisma.saleReturn.findFirstOrThrow({ where: { saleId: s.id } });
    expect([Number(sr.refundAmount), sr.refundMethod, sr.receivedById, sr.displayNumber]).toEqual([900, "ESPECES", admin.id, 1]);
    expect(await prisma.auditEvent.count({ where: { action: "sale.return_created" } })).toBe(1);
  });

  it("cannot return more than was sold — cumulatively across returns, all-or-nothing", async () => {
    const { ctx, sale: s, line } = await soldOnce(4);
    expect((await createSaleReturnAction(ret(s.id, line.id, 3))).ok).toBe(true);
    const tooMany = await createSaleReturnAction(ret(s.id, line.id, 2)); // 3 + 2 > 4
    expect(tooMany.ok).toBe(false);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(9); // 6 + 3, nothing applied by the rejected one
    expect(await prisma.saleReturn.count()).toBe(1);
    expect((await createSaleReturnAction(ret(s.id, line.id, 1))).ok).toBe(true); // exactly the remainder is fine
    expect((await createSaleReturnAction(ret(s.id, line.id, 1))).ok).toBe(false);
  });

  it("a line from ANOTHER sale is rejected", async () => {
    const { ctx, sale: s } = await soldOnce(2);
    const other = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], [{ method: "ESPECES", amount: 300 }]));
    if (!other.ok) throw new Error("setup");
    const otherLine = await prisma.saleLine.findFirstOrThrow({ where: { saleId: other.data.id } });
    expect((await createSaleReturnAction(ret(s.id, otherLine.id, 1))).ok).toBe(false);
  });

  it("is idempotent on (sale, key) — a retry or concurrent double-submit credits stock once", async () => {
    const { ctx, sale: s, line } = await soldOnce(4); // stock 6
    const payload = ret(s.id, line.id, 2);
    const results = await Promise.all([createSaleReturnAction(payload), createSaleReturnAction(payload), createSaleReturnAction(payload)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(8);
    expect(await prisma.saleReturn.count()).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { type: "RETOUR" } })).toBe(1);
  });

  it("concurrent DIFFERENT returns can never exceed what was sold (row-locked)", async () => {
    const { ctx, sale: s, line } = await soldOnce(3);
    const results = await Promise.all([createSaleReturnAction(ret(s.id, line.id, 2)), createSaleReturnAction(ret(s.id, line.id, 2))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await stock(ctx.item.id)).quantityOnHand).toBe(9); // 7 + 2
  });

  it("the refund can never exceed what was collected, net of earlier refunds; a method is required", async () => {
    const { sale: s, line } = await soldOnce(2); // total 600
    expect((await createSaleReturnAction(ret(s.id, line.id, 1, 0, { refundAmount: 300 }))).ok).toBe(false); // no method
    expect((await createSaleReturnAction(ret(s.id, line.id, 1, 0, { refundAmount: 400, refundMethod: "ESPECES" }))).ok).toBe(true);
    expect((await createSaleReturnAction(ret(s.id, line.id, 1, 0, { refundAmount: 300, refundMethod: "ESPECES" }))).ok).toBe(false); // 400 + 300 > 600
    expect((await createSaleReturnAction(ret(s.id, line.id, 1, 0, { refundAmount: 200, refundMethod: "ESPECES" }))).ok).toBe(true);
  });

  it("returns need sales.return, and are scoped: a Store-A user cannot return Store B's sale", async () => {
    const { ctx: ctxA } = await soldOnce(2);
    const storeB = await prisma.warehouse.create({ data: { name: "Boutique B", type: "MAGASIN" } });
    const channelB = await prisma.salesChannel.create({ data: { name: "Magasin B", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: channelB.id, warehouseId: storeB.id } });
    const pB = await prisma.product.create({ data: { name: "PB", sku: "PB-1", price: 10, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: pB.id, salesChannelId: channelB.id } });
    await prisma.inventoryItem.create({ data: { warehouseId: storeB.id, productId: pB.id, quantityOnHand: 5 } });
    const sB = await createSaleAction({
      salesChannelId: channelB.id, warehouseId: storeB.id, idempotencyKey: randomUUID(),
      lines: [{ productId: pB.id, quantity: 1 }], payments: [{ method: "ESPECES", amount: 10 }],
    });
    if (!sB.ok) throw new Error("setup");
    const lineB = await prisma.saleLine.findFirstOrThrow({ where: { saleId: sB.data.id } });

    mockCookieStore.clear();
    const seller = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(seller.id, ctxA.channel.id);
    await grantLocationAccess(seller.id, [ctxA.store.id, storeB.id]);
    const user = (await getCurrentUser())!;

    const visible = await prisma.sale.findMany({ where: saleChannelWhere(user) });
    expect(visible.every((s) => s.salesChannelId === ctxA.channel.id)).toBe(true);
    expect(visible.some((s) => s.id === sB.data.id)).toBe(false);
    expect((await createSaleReturnAction(ret(sB.data.id, lineB.id, 1))).ok).toBe(false); // "introuvable"

    // and without sales.return the action is refused outright
    await prisma.userPermissionOverride.create({ data: { userId: seller.id, permission: "sales.return", effect: "DENY" } });
    await expect(createSaleReturnAction(ret(sB.data.id, lineB.id, 1))).rejects.toThrow(/non autorisé/i);
  });
});

describe("the Online lifecycle is unchanged and shares stock safely", () => {
  async function seedShared() {
    // ONE location serving both channels: the online default channel AND a store channel.
    const wh = await prisma.warehouse.create({ data: { name: "Entrepôt", type: "ENTREPOT", isDefault: true } });
    const online = await ensureDefaultOnlineChannel();
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: store.id, warehouseId: wh.id } });
    const product = await prisma.product.create({ data: { name: "Basket", sku: "SHARED-1", price: 100, status: "ACTIF" } });
    await prisma.productSalesChannel.createMany({
      data: [{ productId: product.id, salesChannelId: online.id }, { productId: product.id, salesChannelId: store.id }],
    });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: wh.id, productId: product.id, quantityOnHand: 10 } });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    return { wh, online, store, product, item, customer };
  }

  it("an online order reserves 6 of 10; the offline sale may take only the 4 available — and the order still ships", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const c = await seedShared();

    const order = await createOrderAction({
      customerId: c.customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      shippingCost: 0,
      discountTotal: 0,
      currency: "MAD",
      items: [{ productId: c.product.id, quantity: 6, unitPrice: 100, discount: 0 }],
    } as never);
    if (!order.ok) throw new Error("setup");
    await updateOrderStatusAction(fd({ id: order.data.id, status: "CONFIRMEE" }));
    let item = await stock(c.item.id);
    expect([item.quantityOnHand, item.quantityReserved]).toEqual([10, 6]); // reservation at CONFIRMEE — unchanged

    const ctx = { channel: c.store, store: c.wh };
    const tooMany = await createSaleAction(sale(ctx, [{ productId: c.product.id, quantity: 5 }], [{ method: "ESPECES", amount: 500 }]));
    expect(tooMany.ok).toBe(false); // would eat a reserved unit
    expect((await createSaleAction(sale(ctx, [{ productId: c.product.id, quantity: 4 }], [{ method: "ESPECES", amount: 400 }]))).ok).toBe(true);
    item = await stock(c.item.id);
    expect([item.quantityOnHand, item.quantityReserved]).toEqual([6, 6]);

    // The order's own lifecycle is intact: EN_PREPARATION → EXPEDIEE fulfils from ITS reservation.
    expect((await updateOrderStatusAction(fd({ id: order.data.id, status: "EN_PREPARATION" }))).ok).toBe(true);
    const shipped = await updateOrderStatusAction(fd({ id: order.data.id, status: "EXPEDIEE" }));
    expect(shipped.ok).toBe(true);
    item = await stock(c.item.id);
    expect([item.quantityOnHand, item.quantityReserved]).toEqual([0, 0]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.data.id } })).status).toBe("EXPEDIEE");
  });

  it("an offline sale does not touch Online orders, and the online physical-return path is unchanged", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const c = await seedShared();
    const order = await createOrderAction({
      customerId: c.customer.id, paymentMethod: "PAIEMENT_LIVRAISON", shippingCost: 0, discountTotal: 0, currency: "MAD",
      items: [{ productId: c.product.id, quantity: 2, unitPrice: 100, discount: 0 }],
    } as never);
    if (!order.ok) throw new Error("setup");
    for (const status of ["CONFIRMEE", "EN_PREPARATION", "EXPEDIEE"]) await updateOrderStatusAction(fd({ id: order.data.id, status }));
    await createSaleAction(sale({ channel: c.store, store: c.wh }, [{ productId: c.product.id, quantity: 3 }], [{ method: "ESPECES", amount: 300 }]));

    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.data.id }, include: { items: true } });
    expect(o.status).toBe("EXPEDIEE");
    const r = await confirmPhysicalReturnAction({
      orderId: o.id, idempotencyKey: randomUUID(),
      lines: [{ orderItemId: o.items[0].id, quantitySellable: 1, quantityDamaged: 0 }],
    });
    expect(r.ok).toBe(true);
    expect((await stock(c.item.id)).quantityOnHand).toBe(6); // 10 − 2 shipped − 3 sold + 1 returned
    // …and the online return's movement carries NO sale reference (and vice-versa).
    const online = await prisma.inventoryMovement.findMany({ where: { orderReturnId: { not: null } } });
    expect(online.every((m) => m.saleId === null && m.saleReturnId === null)).toBe(true);
  });
});

describe("sale lookup for the POS screen", () => {
  it("returns availability at the chosen location (onHand − reserved) and flags an untracked unit", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ctx = await seedStore({ onHand: 10, reserved: 4, sku: "LK-1" });
    const noRow = await prisma.product.create({ data: { name: "Basket rouge", sku: "LK-2", price: 5, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: noRow.id, salesChannelId: ctx.channel.id } });

    const hits = await lookupForSaleAction({ query: "Basket", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    const tracked = hits.find((h) => h.unit.sku === "LK-1");
    const untracked = hits.find((h) => h.unit.sku === "LK-2");
    expect(tracked).toMatchObject({ available: 6, onHand: 10, tracked: true });
    expect(untracked).toMatchObject({ available: 0, tracked: false });
  });

  it("returns nothing for a channel/location the user cannot use", async () => {
    const ctx = await seedStore();
    const u = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(u.id, ctx.channel.id);
    // no location access → resolveSaleContext throws (authorization) — never leaks stock
    await expect(lookupForSaleAction({ query: "Basket", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id })).rejects.toThrow(/non autorisé/i);
    void createTestUser;
  });
});
