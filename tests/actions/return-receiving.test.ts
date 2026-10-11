import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryItem, Product, ShipmentStatus } from "@prisma/client";
import { prisma, prismaBase } from "@/lib/prisma";
import {
  cancelReturnReceptionAction,
  inspectReturnReceptionAction,
  lookupReturnParcelAction,
  receiveReturnParcelAction,
  receiveReturnParcelsAction,
} from "@/actions/return-receiving";
import { confirmPhysicalReturnAction } from "@/actions/returns";
import { listReturnParcels, getReturnParcel, getReceptionForInspection } from "@/lib/queries/return-receiving";
import { getOrderAuditTimeline } from "@/lib/queries/orders";
import { lotRowDisplayState } from "@/lib/returns/lot-row-state";
import { auditActionCategory, humanizeAuditAction } from "@/lib/audit-labels";
import { auditEventDetails } from "@/lib/audit-details";
import { auditJournalDetails, listAuditJournal } from "@/lib/queries/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * P3 returns workspace — reception (stage 1: no stock) and inspection
 * (stage 2: the shared physical-return transaction). Local test DB only;
 * `fetch` is spied in every test to prove no carrier API is ever called.
 */

let fetchSpy: ReturnType<typeof vi.spyOn>;

async function seedParcel(opts: { status?: ShipmentStatus; quantities?: number[]; onHand?: number; tracking?: string } = {}) {
  const quantities = opts.quantities ?? [3];
  const warehouse =
    (await prisma.warehouse.findFirst({ where: { isDefault: true } })) ??
    (await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } }));
  const provider = await prisma.shippingProvider.create({ data: { name: "OzonExpress", type: "API", providerKey: "ozonexpress" } });
  const customer = await prisma.customer.create({ data: { fullName: "Client Retour", phone: "0611223344" } });
  const products: { product: Product; item: InventoryItem }[] = [];
  for (let i = 0; i < quantities.length; i++) {
    const product = await prisma.product.create({ data: { name: `Article ${i}`, sku: `RCV-${randomUUID()}`, price: 100, status: "ACTIF" } });
    const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: opts.onHand ?? 5 } });
    products.push({ product, item });
  }
  const order = await prisma.order.create({
    data: {
      customerId: customer.id,
      subtotal: 100,
      total: 100,
      status: "EXPEDIEE",
      shippedAt: new Date(),
      shippingName: "Fatima Zahra",
      shippingCity: "Casablanca",
      fulfillmentWarehouseId: warehouse.id,
      items: {
        create: quantities.map((q, i) => ({
          productId: products[i].product.id,
          nameSnapshot: `Article ${i}`,
          skuSnapshot: `SKU-${i}`,
          unitPrice: 100,
          quantity: q,
          total: 100 * q,
        })),
      },
    },
    include: { items: { orderBy: { id: "asc" } } },
  });
  const shipment = await prisma.shipment.create({
    data: { orderId: order.id, providerId: provider.id, trackingNumber: opts.tracking ?? `OZ${randomUUID().slice(0, 8).toUpperCase()}`, status: opts.status ?? "RETOURNE" },
  });
  // Items ordered like order.items so tests can index both the same way.
  const itemFor = (orderItemId: string) => products[order.items.findIndex((i) => i.id === orderItemId)].item;
  return { warehouse, provider, order, shipment, products, itemFor };
}

/** A non-global operator (holds orders.return) with access to the default warehouse. */
async function loginOperator() {
  const user = await loginAsTestUser({ role: "MANAGER" });
  return user;
}

async function grantDefaultWarehouse() {
  const user = await getCurrentUser();
  const wh = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
  await grantLocationAccess(user!.id, wh.id);
}

const onHand = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantityOnHand;
const damaged = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).quantityDamaged;

async function receive(shipmentId: string, additional = false) {
  const r = await receiveReturnParcelAction({ shipmentId, additional });
  if (!r.ok) throw new Error("receive failed: " + r.error);
  if (!r.data.ok) throw new Error("receive refused");
  return r.data.receptionId;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(async () => {
  expect(fetchSpy).not.toHaveBeenCalled(); // no carrier API, ever
  fetchSpy.mockRestore();
  await resetDb();
  mockCookieStore.clear();
});

describe("reception — eligibility, lookup and isolation", () => {
  it("a RETOURNE shipment is found by its exact tracking number and received: one A_INSPECTER row, an audit event, nothing else", async () => {
    await loginOperator();
    const { shipment, order, warehouse, products } = await seedParcel({ tracking: "OZRET0001" });
    await grantDefaultWarehouse();

    const found = await lookupReturnParcelAction({ query: "ozret0001" }); // typed lower-case, stored upper-case
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.data).toHaveLength(1);
    expect(found.data[0]).toMatchObject({ shipmentId: shipment.id, eligible: true, state: "A_RECEPTIONNER", city: "Casablanca", recipientName: "Fatima Zahra", warehouseName: warehouse.name });

    const movementsBefore = await prisma.inventoryMovement.count();
    const receptionId = await receive(shipment.id);

    const reception = await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } });
    expect(reception).toMatchObject({ status: "A_INSPECTER", shipmentId: shipment.id, orderId: order.id, warehouseId: warehouse.id, orderReturnId: null });
    expect(reception.receivedById).toBe((await getCurrentUser())!.id);
    // No stock, no order / carrier status change.
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    expect(await onHand(products[0].item.id)).toBe(5);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("EXPEDIEE");
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("RETOURNE");
    expect(await prisma.orderReturn.count()).toBe(0);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.return_received" } });
    expect(audit).toMatchObject({ entityType: "Order", entityId: order.id });

    const view = await getReturnParcel(shipment.id);
    expect(view?.state).toBe("A_INSPECTER");
  });

  it("ECHEC / ANNULE / LIVRE / EN_TRANSIT / EN_ATTENTE shipments are never candidates and cannot be received", async () => {
    await loginOperator();
    const statuses: ShipmentStatus[] = ["ECHEC", "ANNULE", "LIVRE", "EN_TRANSIT", "EN_ATTENTE"];
    const seeded = [];
    for (const status of statuses) seeded.push(await seedParcel({ status }));
    await grantDefaultWarehouse();

    const user = (await getCurrentUser())!;
    const list = await listReturnParcels(user, {});
    expect(list.rows).toHaveLength(0);
    expect(list.counts).toEqual({ A_RECEPTIONNER: 0, A_INSPECTER: 0, INSPECTE: 0, DEJA_RETOURNE: 0 });

    for (const s of seeded) {
      const r = await receiveReturnParcelAction({ shipmentId: s.shipment.id });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/pas au statut « Retourné »/);
    }
    expect(await prisma.returnReception.count()).toBe(0);
  });

  it("the workspace list shows only RETOURNE parcels, by stage", async () => {
    await loginOperator();
    const a = await seedParcel();
    const b = await seedParcel();
    await seedParcel({ status: "ECHEC" });
    await grantDefaultWarehouse();
    await receive(b.shipment.id);
    const user = (await getCurrentUser())!;
    const all = await listReturnParcels(user, {});
    expect(all.rows.map((r) => r.shipmentId).sort()).toEqual([a.shipment.id, b.shipment.id].sort());
    expect(all.counts).toEqual({ A_RECEPTIONNER: 1, A_INSPECTER: 1, INSPECTE: 0, DEJA_RETOURNE: 0 });
    expect((await listReturnParcels(user, { state: "A_INSPECTER" })).rows.map((r) => r.shipmentId)).toEqual([b.shipment.id]);
    expect((await listReturnParcels(user, { q: a.shipment.trackingNumber! })).rows.map((r) => r.shipmentId)).toEqual([a.shipment.id]);
  });

  it("order-number lookup finds the order's shipment; an unknown number is a safe not-found", async () => {
    await loginOperator();
    const { shipment, order } = await seedParcel();
    await grantDefaultWarehouse();
    const byOrder = await lookupReturnParcelAction({ query: String(order.orderNumber) });
    expect(byOrder.ok && byOrder.data.map((p) => p.shipmentId)).toEqual([shipment.id]);
    const unknown = await lookupReturnParcelAction({ query: "NO-SUCH-PARCEL-42" });
    expect(unknown).toEqual({ ok: false, error: "Aucun colis ne correspond à ce numéro." });
  });

  it("another tenant's parcel is never found, received or inspected — and nothing of it changes", async () => {
    const TENANT_B = "tenant-b-return-receiving";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const whB = await prismaBase.warehouse.create({ data: { tenantId: TENANT_B, name: "Entrepôt B", isDefault: true } });
    const prodB = await prismaBase.product.create({ data: { tenantId: TENANT_B, name: "Produit B", sku: "B-1", price: 10, status: "ACTIF" } });
    const itemB = await prismaBase.inventoryItem.create({ data: { tenantId: TENANT_B, warehouseId: whB.id, productId: prodB.id, quantityOnHand: 4 } });
    const custB = await prismaBase.customer.create({ data: { tenantId: TENANT_B, fullName: "Client B" } });
    const provB = await prismaBase.shippingProvider.create({ data: { tenantId: TENANT_B, name: "Ozon B", type: "MANUEL" } });
    const orderB = await prismaBase.order.create({
      data: {
        tenantId: TENANT_B,
        customerId: custB.id,
        subtotal: 10,
        total: 10,
        status: "EXPEDIEE",
        shippedAt: new Date(),
        fulfillmentWarehouseId: whB.id,
        items: { create: [{ tenantId: TENANT_B, productId: prodB.id, nameSnapshot: "Produit B", skuSnapshot: "B-1", unitPrice: 10, quantity: 2, total: 20 }] },
      },
      include: { items: true },
    });
    const shipB = await prismaBase.shipment.create({ data: { tenantId: TENANT_B, orderId: orderB.id, providerId: provB.id, trackingNumber: "TENANTB-TRACK", status: "RETOURNE" } });
    const recB = await prismaBase.returnReception.create({ data: { tenantId: TENANT_B, shipmentId: shipB.id, orderId: orderB.id, warehouseId: whB.id } });

    await loginAsTestUser({ role: "OWNER" }); // global role in tenant A — still nothing of B
    expect(await lookupReturnParcelAction({ query: "TENANTB-TRACK" })).toEqual({ ok: false, error: "Aucun colis ne correspond à ce numéro." });
    expect(await receiveReturnParcelAction({ shipmentId: shipB.id })).toEqual({ ok: false, error: "Colis introuvable." });
    const inspected = await inspectReturnReceptionAction({
      receptionId: recB.id,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: orderB.items[0].id, condition: "SELLABLE", quantity: 1 }],
    });
    expect(inspected).toEqual({ ok: false, error: "Réception introuvable." });
    const batch = await receiveReturnParcelsAction({ shipmentIds: [shipB.id] });
    expect(batch.ok && batch.data[0].result).toMatchObject({ ok: false, code: "not_found" });

    expect(await prismaBase.returnReception.count({ where: { tenantId: TENANT_B } })).toBe(1);
    expect((await prismaBase.returnReception.findUniqueOrThrow({ where: { id: recB.id } })).status).toBe("A_INSPECTER");
    expect(await prismaBase.orderReturn.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect((await prismaBase.inventoryItem.findUniqueOrThrow({ where: { id: itemB.id } })).quantityOnHand).toBe(4);
    expect(await prismaBase.auditEvent.count({ where: { tenantId: TENANT_B } })).toBe(0);
  });

  it("an operator without access to the original warehouse can neither look up, receive nor inspect", async () => {
    await loginOperator(); // MANAGER, zero UserLocation rows
    const { shipment, order } = await seedParcel();
    expect(await lookupReturnParcelAction({ query: shipment.trackingNumber! })).toEqual({
      ok: false,
      error: "Non autorisé : accès à cet emplacement non attribué.",
    });
    expect(await receiveReturnParcelAction({ shipmentId: shipment.id })).toEqual({
      ok: false,
      error: "Non autorisé : accès à cet emplacement non attribué.",
    });
    expect(await prisma.returnReception.count()).toBe(0);

    // A reception made by someone else is still out of reach.
    const reception = await prisma.returnReception.create({ data: { shipmentId: shipment.id, orderId: order.id, warehouseId: order.fulfillmentWarehouseId! } });
    const r = await inspectReturnReceptionAction({
      receptionId: reception.id,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: order.items[0].id, condition: "SELLABLE", quantity: 1 }],
    });
    expect(r).toEqual({ ok: false, error: "Non autorisé : accès à cet emplacement non attribué." });
    expect(await prisma.orderReturn.count()).toBe(0);
    expect((await prisma.returnReception.findUniqueOrThrow({ where: { id: reception.id } })).status).toBe("A_INSPECTER");
  });

  it("forged client-supplied tenant / warehouse / order ids are rejected outright", async () => {
    await loginOperator();
    const { shipment, order } = await seedParcel();
    await grantDefaultWarehouse();
    const other = await prisma.warehouse.create({ data: { name: "Autre entrepôt" } });

    const forgedReceive = await receiveReturnParcelAction({ shipmentId: shipment.id, warehouseId: other.id, tenantId: "x" } as never);
    expect(forgedReceive.ok).toBe(false);
    if (!forgedReceive.ok) expect(forgedReceive.error).toBe("Champs invalides.");
    expect(await prisma.returnReception.count()).toBe(0);

    const receptionId = await receive(shipment.id);
    expect((await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } })).warehouseId).toBe(order.fulfillmentWarehouseId);

    const forgedInspect = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      orderId: "forged",
      warehouseId: other.id,
      entries: [{ orderItemId: order.items[0].id, condition: "SELLABLE", quantity: 1 }],
    } as never);
    expect(forgedInspect.ok).toBe(false);

    // An order item of ANOTHER order is refused.
    const second = await seedParcel();
    const foreignLine = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: second.order.items[0].id, condition: "SELLABLE", quantity: 1 }],
    });
    expect(foreignLine).toEqual({ ok: false, error: "Une ligne de retour référence un article qui n'appartient pas à cette commande." });
    expect(await prisma.orderReturn.count()).toBe(0);
  });

  it("a role without orders.return is refused", async () => {
    const { shipment } = await seedParcel();
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(receiveReturnParcelAction({ shipmentId: shipment.id })).rejects.toThrow(/non autoris/i);
    await expect(lookupReturnParcelAction({ query: shipment.trackingNumber! })).rejects.toThrow(/non autoris/i);
  });
});

describe("reception — duplicates and concurrency", () => {
  it("a repeated reception is idempotent: same reception, still one row", async () => {
    await loginOperator();
    const { shipment } = await seedParcel();
    await grantDefaultWarehouse();
    const first = await receiveReturnParcelAction({ shipmentId: shipment.id });
    const second = await receiveReturnParcelAction({ shipmentId: shipment.id });
    expect(first.ok && first.data).toMatchObject({ ok: true, status: "received" });
    expect(second.ok && second.data).toMatchObject({ ok: true, status: "already_pending" });
    if (first.ok && second.ok && first.data.ok && second.data.ok) expect(second.data.receptionId).toBe(first.data.receptionId);
    expect(await prisma.returnReception.count()).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: "order.return_received" } })).toBe(1);
  });

  it("concurrent receptions of the same parcel persist exactly one reception", async () => {
    await loginOperator();
    const { shipment } = await seedParcel();
    await grantDefaultWarehouse();
    const results = await Promise.all(Array.from({ length: 5 }, () => receiveReturnParcelAction({ shipmentId: shipment.id })));
    expect(results.every((r) => r.ok && r.data.ok)).toBe(true);
    const statuses = results.map((r) => (r.ok && r.data.ok ? r.data.status : "x"));
    expect(statuses.filter((s) => s === "received")).toHaveLength(1);
    expect(statuses.filter((s) => s === "already_pending")).toHaveLength(4);
    expect(await prisma.returnReception.count()).toBe(1);
  });

  it("the database itself refuses a second reception awaiting inspection for one shipment (partial unique index)", async () => {
    const { shipment, order } = await seedParcel();
    const data = { shipmentId: shipment.id, orderId: order.id, warehouseId: order.fulfillmentWarehouseId! };
    await prisma.returnReception.create({ data });
    const err = await prisma.returnReception.create({ data }).catch((e: unknown) => e);
    expect(isUniqueConstraintError(err)).toBe(true);
    // …and the status / inspection-link CHECK.
    const bad = await prisma.returnReception.update({ where: { id: (await prisma.returnReception.findFirstOrThrow()).id }, data: { status: "INSPECTE" } }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(Error);
  });

  it("batch reception reports each parcel separately — one bad parcel never hides or blocks the others", async () => {
    await loginOperator();
    const ok1 = await seedParcel();
    const ok2 = await seedParcel();
    const failed = await seedParcel({ status: "ECHEC" });
    await grantDefaultWarehouse();
    await receive(ok2.shipment.id); // already received before the batch

    const r = await receiveReturnParcelsAction({ shipmentIds: [ok1.shipment.id, failed.shipment.id, ok2.shipment.id, "does-not-exist", ok1.shipment.id] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.data.map((i) => [i.shipmentId, i.result]));
    expect(r.data).toHaveLength(4); // duplicate id processed once
    expect(byId.get(ok1.shipment.id)).toMatchObject({ ok: true, status: "received" });
    expect(byId.get(ok2.shipment.id)).toMatchObject({ ok: true, status: "already_pending" });
    expect(byId.get(failed.shipment.id)).toMatchObject({ ok: false, code: "not_eligible" });
    expect(byId.get("does-not-exist")).toMatchObject({ ok: false, code: "not_found" });
    expect(await prisma.returnReception.count()).toBe(2);
  });
});

describe("inspection", () => {
  it("cannot start before reception", async () => {
    await loginOperator();
    const { order } = await seedParcel();
    await grantDefaultWarehouse();
    const r = await inspectReturnReceptionAction({
      receptionId: "no-reception-yet",
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: order.items[0].id, condition: "SELLABLE", quantity: 1 }],
    });
    expect(r).toEqual({ ok: false, error: "Réception introuvable." });
    expect(await prisma.orderReturn.count()).toBe(0);
  });

  it("the unit condition is mandatory — a missing or unknown condition is never treated as sellable", async () => {
    await loginOperator();
    const { shipment, order, products } = await seedParcel();
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    for (const entry of [
      { orderItemId: order.items[0].id, quantity: 1 },
      { orderItemId: order.items[0].id, quantity: 1, condition: "UNKNOWN" },
      { orderItemId: order.items[0].id, quantity: 1, quantitySellable: 1 },
    ]) {
      const r = await inspectReturnReceptionAction({ receptionId, idempotencyKey: randomUUID(), entries: [entry] } as never);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("Champs invalides.");
    }
    expect(await prisma.orderReturn.count()).toBe(0);
    expect(await onHand(products[0].item.id)).toBe(5);
    expect((await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } })).status).toBe("A_INSPECTER");
  });

  it("sellable units restock via RETOUR, damaged units via ENDOMMAGE (never on-hand); duplicates aggregate; reception linked; statuses untouched", async () => {
    await loginOperator();
    const { shipment, order, itemFor } = await seedParcel({ quantities: [4, 2] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    const [a, b] = order.items;

    const r = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      note: "Carton abîmé",
      entries: [
        { orderItemId: a.id, condition: "SELLABLE", quantity: 2 },
        { orderItemId: a.id, condition: "SELLABLE", quantity: 1 },
        { orderItemId: a.id, condition: "DAMAGED", quantity: 1 },
        { orderItemId: b.id, condition: "DAMAGED", quantity: 2 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(await onHand(itemFor(a.id).id)).toBe(5 + 3);
    expect(await damaged(itemFor(a.id).id)).toBe(1);
    expect(await onHand(itemFor(b.id).id)).toBe(5); // damaged never increases on-hand
    expect(await damaged(itemFor(b.id).id)).toBe(2);

    const ret = await prisma.orderReturn.findUniqueOrThrow({ where: { id: r.data.orderReturnId }, include: { lines: true, movements: true } });
    expect(ret.note).toBe("Carton abîmé");
    expect(ret.lines.find((l) => l.orderItemId === a.id)).toMatchObject({ quantitySellable: 3, quantityDamaged: 1 });
    expect(ret.lines).toHaveLength(2); // one line per order item, duplicates merged
    expect(ret.movements.map((m) => `${m.type}:${m.quantity}`).sort()).toEqual(["ENDOMMAGE:1", "ENDOMMAGE:2", "RETOUR:3"]);

    const reception = await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } });
    expect(reception).toMatchObject({ status: "INSPECTE", orderReturnId: ret.id });
    expect(reception.inspectedAt).not.toBeNull();
    expect(reception.inspectedById).toBe((await getCurrentUser())!.id);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("EXPEDIEE");
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("RETOURNE");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.return_confirmed" } });
    expect(audit.metadata).toMatchObject({ returnReceptionId: receptionId, shipmentId: shipment.id });
    expect((await getReturnParcel(shipment.id))?.state).toBe("INSPECTE");
  });

  it("quantity limits: shipped − already returned (including order-page returns); a refused inspection leaves the reception awaiting inspection", async () => {
    await loginOperator();
    const { shipment, order, itemFor } = await seedParcel({ quantities: [3] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    const line = order.items[0];

    const over = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: line.id, condition: "SELLABLE", quantity: 4 }],
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/4 unité\(s\) demandée\(s\), 3 restante\(s\)/);

    // The order-page physical return still works, and shares the ceiling.
    const fromOrderPage = await confirmPhysicalReturnAction({
      orderId: order.id,
      idempotencyKey: randomUUID(),
      lines: [{ orderItemId: line.id, quantitySellable: 1, quantityDamaged: 0 }],
    });
    expect(fromOrderPage.ok).toBe(true);

    const stillOver = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: line.id, condition: "DAMAGED", quantity: 3 }],
    });
    expect(stillOver.ok).toBe(false);
    expect((await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } })).status).toBe("A_INSPECTER");
    expect(await prisma.orderReturn.count()).toBe(1); // only the order-page one

    const ok = await inspectReturnReceptionAction({
      receptionId,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: line.id, condition: "SELLABLE", quantity: 2 }],
    });
    expect(ok.ok).toBe(true);
    expect(await onHand(itemFor(line.id).id)).toBe(5 + 1 + 2);
  });

  it("units not in the parcel stay returnable: a later, explicitly confirmed reception can receive them; nothing is closed early", async () => {
    await loginOperator();
    const { shipment, order, itemFor } = await seedParcel({ quantities: [3] });
    await grantDefaultWarehouse();
    const line = order.items[0];

    const first = await receive(shipment.id);
    expect((await inspectReturnReceptionAction({ receptionId: first, idempotencyKey: randomUUID(), entries: [{ orderItemId: line.id, condition: "SELLABLE", quantity: 1 }] })).ok).toBe(true);
    const view = await getReturnParcel(shipment.id);
    expect(view).toMatchObject({ state: "INSPECTE", returnedUnits: 1, remainingUnits: 2 });

    // A plain re-scan of the inspected parcel never silently opens a new reception…
    const rescan = await receiveReturnParcelAction({ shipmentId: shipment.id });
    expect(rescan.ok).toBe(false);
    if (!rescan.ok) expect(rescan.error).toMatch(/déjà été réceptionné et inspecté/);
    // …nor does a batch.
    const batch = await receiveReturnParcelsAction({ shipmentIds: [shipment.id] });
    expect(batch.ok && batch.data[0].result).toMatchObject({ ok: false, code: "already_inspected" });
    expect(await prisma.returnReception.count()).toBe(1);

    // The explicit later reception does.
    const second = await receive(shipment.id, true);
    expect(second).not.toBe(first);
    expect((await inspectReturnReceptionAction({ receptionId: second, idempotencyKey: randomUUID(), entries: [{ orderItemId: line.id, condition: "DAMAGED", quantity: 2 }] })).ok).toBe(true);
    expect(await onHand(itemFor(line.id).id)).toBe(6);
    expect(await damaged(itemFor(line.id).id)).toBe(2);

    // Everything is back now — no further reception.
    const none = await receiveReturnParcelAction({ shipmentId: shipment.id, additional: true });
    expect(none).toEqual({ ok: false, error: "Toutes les unités de cette commande ont déjà été retournées." });
  });

  it("a repeated inspection (same key) is a no-op; a second inspection (new key) is refused — no duplicate event or movement", async () => {
    await loginOperator();
    const { shipment, order, itemFor } = await seedParcel({ quantities: [3] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    const key = randomUUID();
    const entries = [{ orderItemId: order.items[0].id, condition: "SELLABLE" as const, quantity: 1 }];

    const first = await inspectReturnReceptionAction({ receptionId, idempotencyKey: key, entries });
    const retry = await inspectReturnReceptionAction({ receptionId, idempotencyKey: key, entries });
    expect(first.ok && retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(retry.data).toEqual({ orderReturnId: first.data.orderReturnId, replay: true });
    }
    const again = await inspectReturnReceptionAction({ receptionId, idempotencyKey: randomUUID(), entries });
    expect(again).toEqual({ ok: false, error: "Ce colis a déjà été inspecté." });

    expect(await prisma.orderReturn.count()).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { type: "RETOUR" } })).toBe(1);
    expect(await onHand(itemFor(order.items[0].id).id)).toBe(6);
  });

  it("two operators inspecting the same parcel concurrently: exactly one inspection is recorded", async () => {
    await loginOperator();
    const { shipment, order, itemFor } = await seedParcel({ quantities: [3] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    const entries = [{ orderItemId: order.items[0].id, condition: "SELLABLE" as const, quantity: 2 }];

    const results = await Promise.all([
      inspectReturnReceptionAction({ receptionId, idempotencyKey: randomUUID(), entries }),
      inspectReturnReceptionAction({ receptionId, idempotencyKey: randomUUID(), entries }),
      inspectReturnReceptionAction({ receptionId, idempotencyKey: randomUUID(), entries }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "Ce colis a déjà été inspecté.")).toHaveLength(2);
    expect(await prisma.orderReturn.count()).toBe(1);
    expect(await prisma.inventoryMovement.count({ where: { type: "RETOUR" } })).toBe(1);
    expect(await onHand(itemFor(order.items[0].id).id)).toBe(7);
  });
});

describe("integration with the scan-lot badge and the order history", () => {
  it("lot badges follow the server's real answers, including a parcel that changed after it was scanned", async () => {
    await loginOperator();
    const fresh = await seedParcel();
    const pending = await seedParcel();
    const failed = await seedParcel({ status: "ECHEC" });
    const inspected = await seedParcel({ quantities: [2] });
    const turnedIneligible = await seedParcel();
    await grantDefaultWarehouse();
    await receive(pending.shipment.id);
    const done = await receive(inspected.shipment.id);
    await inspectReturnReceptionAction({
      receptionId: done,
      idempotencyKey: randomUUID(),
      entries: [{ orderItemId: inspected.order.items[0].id, condition: "SELLABLE", quantity: 1 }],
    });

    // What the lot holds: each parcel as it was when scanned.
    const scanned = new Map<string, Parameters<typeof lotRowDisplayState>[0]>();
    for (const p of [fresh, pending, failed, inspected, turnedIneligible]) {
      const r = await lookupReturnParcelAction({ query: p.shipment.trackingNumber! });
      if (!r.ok) throw new Error(r.error);
      scanned.set(p.shipment.id, r.data[0]);
    }
    expect(lotRowDisplayState(scanned.get(failed.shipment.id)!)).toBe("NON_ELIGIBLE"); // before any reception attempt
    expect(lotRowDisplayState(scanned.get(turnedIneligible.shipment.id)!)).toBe("A_RECEPTIONNER");

    // The carrier status changes between the scan and « Réceptionner le lot ».
    await prisma.shipment.update({ where: { id: turnedIneligible.shipment.id }, data: { status: "LIVRE" } });

    const r = await receiveReturnParcelsAction({ shipmentIds: [...scanned.keys()] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const badge = (id: string) => lotRowDisplayState(scanned.get(id)!, r.data.find((i) => i.shipmentId === id)!.result);
    expect(badge(fresh.shipment.id)).toBe("A_INSPECTER");
    expect(badge(pending.shipment.id)).toBe("A_INSPECTER");
    expect(badge(failed.shipment.id)).toBe("NON_ELIGIBLE");
    expect(badge(inspected.shipment.id)).toBe("INSPECTE");
    expect(badge(turnedIneligible.shipment.id)).toBe("NON_ELIGIBLE");
    // Badges match the stored truth.
    expect((await getReturnParcel(fresh.shipment.id))?.state).toBe("A_INSPECTER");
    expect((await getReturnParcel(turnedIneligible.shipment.id))?.eligible).toBe(false);
  });

  it("every event the workflow writes on the order shows a French label and a category in the order history", async () => {
    await loginOperator();
    const { shipment, order } = await seedParcel({ quantities: [3] });
    await grantDefaultWarehouse();
    const line = order.items[0];

    const first = await receive(shipment.id);
    await inspectReturnReceptionAction({ receptionId: first, idempotencyKey: randomUUID(), entries: [{ orderItemId: line.id, condition: "SELLABLE", quantity: 2 }] });
    const second = await receive(shipment.id, true);
    await inspectReturnReceptionAction({ receptionId: second, idempotencyKey: randomUUID(), entries: [{ orderItemId: line.id, condition: "DAMAGED", quantity: 1 }] });

    // Same query as the order page's « Historique ».
    const timeline = await getOrderAuditTimeline(order.id);
    const actions = timeline.map((e) => e.action).reverse();
    expect(actions).toEqual(["order.return_received", "order.return_confirmed", "order.return_received", "order.return_confirmed"]);
    for (const e of timeline) {
      expect(auditActionCategory(e.action), e.action).toBe("commandes");
    }
    expect(actions.map(humanizeAuditAction)).toEqual([
      "Colis retourné réceptionné",
      "Retour physique enregistré",
      "Colis retourné réceptionné",
      "Retour physique enregistré",
    ]);
  });
});

/** Return the order's units through the ORDER PAGE (no reception) — the pre-P3 path. */
async function returnFromOrderPage(orderItemId: string, orderId: string, quantity: number) {
  const r = await confirmPhysicalReturnAction({
    orderId,
    idempotencyKey: randomUUID(),
    lines: [{ orderItemId, quantitySellable: quantity, quantityDamaged: 0 }],
  });
  if (!r.ok) throw new Error("order-page return failed: " + r.error);
}

describe("H1 — parcels whose units were all returned elsewhere are never « À réceptionner »", () => {
  it("a fully returned parcel is « Déjà retourné »: out of the « À réceptionner » list and count, still findable by scan", async () => {
    await loginOperator();
    const done = await seedParcel({ quantities: [2] });
    const partial = await seedParcel({ quantities: [3] });
    const untouched = await seedParcel({ quantities: [1] });
    await grantDefaultWarehouse();
    await returnFromOrderPage(done.order.items[0].id, done.order.id, 2); // every unit back
    await returnFromOrderPage(partial.order.items[0].id, partial.order.id, 1); // 2 still outstanding

    const user = (await getCurrentUser())!;
    const awaiting = await listReturnParcels(user, { state: "A_RECEPTIONNER" });
    expect(awaiting.rows.map((r) => r.shipmentId).sort()).toEqual([partial.shipment.id, untouched.shipment.id].sort());
    expect(awaiting.total).toBe(2);
    expect(awaiting.counts.A_RECEPTIONNER).toBe(2);
    expect(awaiting.counts.DEJA_RETOURNE).toBe(1);

    const already = await listReturnParcels(user, { state: "DEJA_RETOURNE" });
    expect(already.rows.map((r) => r.shipmentId)).toEqual([done.shipment.id]);
    // « Toutes les étapes » is the workspace's work, not the already-returned history.
    expect((await listReturnParcels(user, {})).rows.map((r) => r.shipmentId)).not.toContain(done.shipment.id);

    // A scan still finds it and says why it can't be received.
    const scanned = await lookupReturnParcelAction({ query: done.shipment.trackingNumber! });
    expect(scanned.ok && scanned.data[0]).toMatchObject({ state: "DEJA_RETOURNE", remainingUnits: 0 });
    const refused = await receiveReturnParcelsAction({ shipmentIds: [done.shipment.id] });
    expect(refused.ok && refused.data[0].result).toMatchObject({ ok: false, code: "nothing_remaining" });
    expect(await prisma.returnReception.count()).toBe(0);
  });

  it("the « À réceptionner » set honours warehouse scope and tenant isolation", async () => {
    await loginOperator(); // no warehouse granted
    await seedParcel({ quantities: [1] });
    const user = (await getCurrentUser())!;
    const res = await listReturnParcels(user, { state: "A_RECEPTIONNER" });
    expect(res.total).toBe(0);
    expect(res.counts.A_RECEPTIONNER).toBe(0);

    // Another tenant's awaiting parcel is never counted.
    await prismaBase.tenant.create({ data: { id: "tenant-h1", name: "H1", slug: "tenant-h1" } });
    const wh = await prismaBase.warehouse.create({ data: { tenantId: "tenant-h1", name: "W", isDefault: true } });
    const provider = await prismaBase.shippingProvider.create({ data: { tenantId: "tenant-h1", name: "P" } });
    const customer = await prismaBase.customer.create({ data: { tenantId: "tenant-h1", fullName: "X" } });
    const order = await prismaBase.order.create({
      data: { tenantId: "tenant-h1", customerId: customer.id, subtotal: 1, total: 1, status: "EXPEDIEE", shippedAt: new Date(), fulfillmentWarehouseId: wh.id,
        items: { create: [{ tenantId: "tenant-h1", nameSnapshot: "A", skuSnapshot: "A", unitPrice: 1, quantity: 1, total: 1 }] } },
    });
    await prismaBase.shipment.create({ data: { tenantId: "tenant-h1", orderId: order.id, providerId: provider.id, trackingNumber: "H1-OTHER", status: "RETOURNE" } });
    await grantDefaultWarehouse();
    const mine = await listReturnParcels((await getCurrentUser())!, { state: "A_RECEPTIONNER" });
    expect(mine.counts.A_RECEPTIONNER).toBe(1);
    expect(mine.rows.every((r) => r.trackingNumber !== "H1-OTHER")).toBe(true);
  });
});

describe("M4 — cancelling a reception that can't be inspected", () => {
  it("an empty parcel: the reception is voided with its reason, nothing else changes, and the parcel can be received again", async () => {
    await loginOperator();
    const { shipment, order, products } = await seedParcel({ quantities: [2] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    const movementsBefore = await prisma.inventoryMovement.count();

    const r = await cancelReturnReceptionAction({ receptionId, reason: "COLIS_VIDE", note: "Carton vide à l'ouverture" });
    expect(r).toEqual({ ok: true, data: { orderId: order.id } });

    expect(await prisma.returnReception.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    expect(await onHand(products[0].item.id)).toBe(5);
    expect(await prisma.orderReturn.count()).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("EXPEDIEE");
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } })).status).toBe("RETOURNE");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.return_reception_cancelled" } });
    expect(audit).toMatchObject({ entityType: "Order", entityId: order.id });
    expect(audit.metadata).toMatchObject({ reason: "COLIS_VIDE", reasonLabel: "Colis vide", note: "Carton vide à l'ouverture" });
    expect(audit.previousValue).toMatchObject({ returnReceptionId: receptionId, shipmentId: shipment.id });

    // Units still outstanding → back to « À réceptionner », receivable again.
    expect((await getReturnParcel(shipment.id))?.state).toBe("A_RECEPTIONNER");
    const again = await receive(shipment.id);
    expect(again).not.toBe(receptionId);
  });

  it("units already returned from the order page: cancelling unblocks the parcel, which becomes « Déjà retourné »", async () => {
    await loginOperator();
    const { shipment, order } = await seedParcel({ quantities: [1] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    await returnFromOrderPage(order.items[0].id, order.id, 1);

    // Inspection is now impossible (nothing left)…
    const stuck = await inspectReturnReceptionAction({ receptionId, idempotencyKey: randomUUID(), entries: [{ orderItemId: order.items[0].id, condition: "SELLABLE", quantity: 1 }] });
    expect(stuck.ok).toBe(false);
    // …the cancellation is the way out.
    expect((await cancelReturnReceptionAction({ receptionId, reason: "DEJA_RETOURNE" })).ok).toBe(true);
    expect((await getReturnParcel(shipment.id))?.state).toBe("DEJA_RETOURNE");
    expect(await prisma.orderReturn.count()).toBe(1); // only the order-page return
  });

  it("an inspected reception can't be cancelled; a cancelled one can't be inspected or cancelled twice", async () => {
    await loginOperator();
    const a = await seedParcel({ quantities: [1] });
    const b = await seedParcel({ quantities: [1] });
    await grantDefaultWarehouse();

    const inspectedId = await receive(a.shipment.id);
    await inspectReturnReceptionAction({ receptionId: inspectedId, idempotencyKey: randomUUID(), entries: [{ orderItemId: a.order.items[0].id, condition: "SELLABLE", quantity: 1 }] });
    const refused = await cancelReturnReceptionAction({ receptionId: inspectedId, reason: "MAUVAIS_COLIS" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/déjà été inspecté/);
    expect(await prisma.returnReception.count({ where: { id: inspectedId } })).toBe(1);

    const voidedId = await receive(b.shipment.id);
    expect((await cancelReturnReceptionAction({ receptionId: voidedId, reason: "MAUVAIS_COLIS" })).ok).toBe(true);
    const twice = await cancelReturnReceptionAction({ receptionId: voidedId, reason: "MAUVAIS_COLIS" });
    expect(twice.ok).toBe(false);
    const late = await inspectReturnReceptionAction({ receptionId: voidedId, idempotencyKey: randomUUID(), entries: [{ orderItemId: b.order.items[0].id, condition: "SELLABLE", quantity: 1 }] });
    expect(late.ok).toBe(false); // a clean refusal, never an unhandled error
    expect(await prisma.auditEvent.count({ where: { action: "order.return_reception_cancelled" } })).toBe(1);
  });

  it("validation, warehouse access and tenant isolation", async () => {
    await loginOperator();
    const { shipment } = await seedParcel({ quantities: [1] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);

    expect((await cancelReturnReceptionAction({ receptionId, reason: "AUTRE" })).ok).toBe(false); // « Autre » needs a note
    expect((await cancelReturnReceptionAction({ receptionId, reason: "COLIS_VIDE", tenantId: "x" } as never)).ok).toBe(false);

    await loginOperator(); // a manager WITHOUT this warehouse
    const denied = await cancelReturnReceptionAction({ receptionId, reason: "COLIS_VIDE" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/Non autorisé/);

    await prismaBase.tenant.create({ data: { id: "tenant-m4", name: "M4", slug: "tenant-m4" } });
    await loginAsTestUser({ role: "OWNER", tenantId: "tenant-m4" });
    const otherTenant = await cancelReturnReceptionAction({ receptionId, reason: "COLIS_VIDE" });
    expect(otherTenant.ok).toBe(false);
    expect(await prismaBase.returnReception.count({ where: { id: receptionId } })).toBe(1);
  });
});

describe("S5 — a cancelled reception stays understandable, and cancel / inspect never both win", () => {
  it("the order history and the audit journal show the reason, its note and the parcel", async () => {
    await loginOperator();
    const { shipment, order } = await seedParcel({ quantities: [1] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);
    expect((await cancelReturnReceptionAction({ receptionId, reason: "AUTRE", note: "Colis d'un autre client" })).ok).toBe(true);

    const timeline = await getOrderAuditTimeline(order.id);
    const cancelled = timeline.find((e) => e.action === "order.return_reception_cancelled")!;
    expect(auditEventDetails(cancelled)).toEqual(["Motif : Autre motif", "Note : Colis d'un autre client", `Colis : ${shipment.trackingNumber}`]);

    const user = (await getCurrentUser())!;
    const journal = await listAuditJournal(user, { category: "commandes" });
    const row = journal.items.find((e) => e.action === "order.return_reception_cancelled")!;
    expect(Object.keys(row)).not.toContain("metadata"); // the journal never loads payloads (Phase 4C)
    expect((await auditJournalDetails(journal.items)).get(row.id)).toContain("Motif : Autre motif");
  });

  it("cancel and inspect fired together: exactly one wins, and the state matches the winner", async () => {
    await loginOperator();
    const { shipment, order, products } = await seedParcel({ quantities: [1] });
    await grantDefaultWarehouse();
    const receptionId = await receive(shipment.id);

    const [cancel, inspect] = await Promise.all([
      cancelReturnReceptionAction({ receptionId, reason: "COLIS_VIDE" }),
      inspectReturnReceptionAction({
        receptionId,
        idempotencyKey: randomUUID(),
        entries: [{ orderItemId: order.items[0].id, condition: "SELLABLE", quantity: 1 }],
      }),
    ]);
    expect([cancel.ok, inspect.ok].filter(Boolean)).toHaveLength(1);
    if (cancel.ok) {
      expect(await prisma.returnReception.count()).toBe(0);
      expect(await prisma.orderReturn.count()).toBe(0);
      expect(await onHand(products[0].item.id)).toBe(5);
    } else {
      expect((await prisma.returnReception.findUniqueOrThrow({ where: { id: receptionId } })).status).toBe("INSPECTE");
      expect(await prisma.orderReturn.count()).toBe(1);
      expect(await onHand(products[0].item.id)).toBe(6);
      expect(await prisma.auditEvent.count({ where: { action: "order.return_reception_cancelled" } })).toBe(0);
    }
  });
});

describe("getReceptionForInspection — the inspection page's read is scoped", () => {
  it("returns null for another tenant's reception, even for a global role", async () => {
    const TENANT_B = "tenant-b-reception-inspection";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const whB = await prismaBase.warehouse.create({ data: { tenantId: TENANT_B, name: "Entrepôt B", isDefault: true } });
    const custB = await prismaBase.customer.create({ data: { tenantId: TENANT_B, fullName: "Client B" } });
    const provB = await prismaBase.shippingProvider.create({ data: { tenantId: TENANT_B, name: "Ozon B", type: "MANUEL" } });
    const orderB = await prismaBase.order.create({
      data: { tenantId: TENANT_B, customerId: custB.id, subtotal: 10, total: 10, status: "EXPEDIEE", shippedAt: new Date(), fulfillmentWarehouseId: whB.id },
    });
    const shipB = await prismaBase.shipment.create({ data: { tenantId: TENANT_B, orderId: orderB.id, providerId: provB.id, trackingNumber: "TENANTB-INSPECT", status: "RETOURNE" } });
    const recB = await prismaBase.returnReception.create({ data: { tenantId: TENANT_B, shipmentId: shipB.id, orderId: orderB.id, warehouseId: whB.id } });

    await loginAsTestUser({ role: "OWNER" }); // global role in tenant A
    const viewer = await getCurrentUser();
    expect(await getReceptionForInspection(recB.id, viewer!)).toBeNull();
  });

  it("returns null for a user without access to the reception's warehouse, the view once access is granted", async () => {
    await loginOperator(); // MANAGER, zero UserLocation rows
    const { shipment, order } = await seedParcel();
    const reception = await prisma.returnReception.create({ data: { shipmentId: shipment.id, orderId: order.id, warehouseId: order.fulfillmentWarehouseId! } });

    expect(await getReceptionForInspection(reception.id, (await getCurrentUser())!)).toBeNull();

    await grantDefaultWarehouse();
    const view = await getReceptionForInspection(reception.id, (await getCurrentUser())!);
    expect(view?.receptionId).toBe(reception.id);
  });
});
