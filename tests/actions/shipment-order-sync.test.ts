import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  configureDeliveryProviderApiAction,
  createShipmentAction,
  createShipmentViaProviderAction,
  createShippingProviderAction,
  deleteFailedShipmentAction,
  syncShipmentStatusAction,
  updateShipmentStatusAction,
} from "@/actions/delivery";
import { createOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { confirmPhysicalReturnAction } from "@/actions/returns";
import { getCurrentUser } from "@/lib/auth/session";
import { hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { resetDb } from "../helpers/db";
import { grantLocationAccess, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { registerReferenceDeliveryProvider, REFERENCE_PROVIDER_KEY } from "../helpers/reference-delivery-provider";
import { emptyFakeCarrierState, FAKE_API_KEY, installFakeReferenceCarrier, type FakeCarrierState } from "../helpers/fake-reference-carrier";

/**
 * S1 — a parcel's progress drives its order: « En transit » / « Livré » on an
 * order still before « Expédiée » ships it first (stock deducted exactly once),
 * manual failures stay in the history, a carrier parcel is never « Annulé »
 * locally, one active parcel per order across carriers, and an order whose
 * goods came back is never re-shipped on the same order.
 */

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

let carrier: FakeCarrierState;
const ON_HAND_START = 10;

async function seedOrder(quantity = 2) {
  const warehouse = await prisma.warehouse.create({ data: { id: "default-warehouse", name: "Entrepôt principal", isDefault: true } });
  const actor = await getCurrentUser();
  if (actor && !hasGlobalLocationAccess(actor.role)) await grantLocationAccess(actor.id, warehouse.id);
  const product = await prisma.product.create({ data: { name: "Coffret", sku: "SKU-S1", price: 100, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: ON_HAND_START } });
  const customer = await prisma.customer.create({ data: { fullName: "Amine Tazi" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod: "PAIEMENT_LIVRAISON",
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "12 rue Hassan II",
    shippingAddressLine2: "",
    shippingCity: "Rabat",
    shippingRegion: "",
    shippingCountry: "MA",
    shippingPhone: "0600000000",
    items: [{ productId: product.id, quantity, unitPrice: 100, discount: 0 }],
  });
  if (!created.ok) throw new Error("setup failed");
  const orderId = created.data.id;
  expect((await updateOrderStatusAction(fd({ id: orderId, status: "CONFIRMEE" }))).ok).toBe(true);
  return { orderId, productId: product.id };
}

async function manualProvider(name = "Livreur maison") {
  const p = await createShippingProviderAction(fd({ name, type: "MANUEL" }));
  if (!p.ok) throw new Error("setup failed");
  return p.data.id;
}

async function apiProvider() {
  const p = await createShippingProviderAction(fd({ name: "Transporteur API", type: "API" }));
  if (!p.ok) throw new Error("setup failed");
  await configureDeliveryProviderApiAction(
    fd({ providerId: p.data.id, providerKey: REFERENCE_PROVIDER_KEY, credentialsJson: JSON.stringify({ apiKey: FAKE_API_KEY }) })
  );
  return p.data.id;
}

async function manualShipment(orderId: string, providerId?: string) {
  const s = await createShipmentAction(fd({ orderId, providerId: providerId ?? (await manualProvider()) }));
  if (!s.ok) throw new Error("shipment setup failed: " + s.error);
  return s.data.id;
}

const setStatus = (id: string, status: string, failedReason?: string) =>
  updateShipmentStatusAction(fd({ id, status, ...(failedReason ? { failedReason } : {}) }));

async function stock(productId: string) {
  const row = await prisma.inventoryItem.findFirstOrThrow({ where: { productId } });
  return { onHand: row.quantityOnHand, reserved: row.quantityReserved };
}

const orderStatus = async (id: string) => (await prisma.order.findUniqueOrThrow({ where: { id } })).status;
const saleMovements = (productId: string) => prisma.inventoryMovement.count({ where: { inventoryItem: { productId }, type: "VENTE" } });

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  registerReferenceDeliveryProvider();
  carrier = emptyFakeCarrierState();
  installFakeReferenceCarrier(carrier);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await resetDb();
  mockCookieStore.clear();
});

describe("S1 — a moving parcel ships its order (once)", () => {
  it("« Livré » on a « Confirmée » order: Expédiée then Livrée, stock deducted once, both audited", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(2);
    expect(await stock(productId)).toEqual({ onHand: 10, reserved: 2 });
    const shipmentId = await manualShipment(orderId);

    expect((await setStatus(shipmentId, "LIVRE")).ok).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("LIVREE");
    expect(order.shippedAt).not.toBeNull();
    expect(order.deliveredAt).not.toBeNull();
    expect(await stock(productId)).toEqual({ onHand: 8, reserved: 0 });
    expect(await saleMovements(productId)).toBe(1);

    const audits = await prisma.auditEvent.findMany({
      where: { action: "order.status_changed", entityId: orderId, metadata: { path: ["via"], equals: "shipment" } },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => (a.newValue as { status: string }).status)).toEqual(["EXPEDIEE", "LIVREE"]);
    expect(audits[0].previousValue).toEqual({ status: "CONFIRMEE" });
  });

  it("« En transit » on an « En préparation » order ships it; a later « Livré » never deducts again", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    await updateOrderStatusAction(fd({ id: orderId, status: "EN_PREPARATION" }));
    const shipmentId = await manualShipment(orderId);

    expect((await setStatus(shipmentId, "EN_TRANSIT")).ok).toBe(true);
    expect(await orderStatus(orderId)).toBe("EXPEDIEE");
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });

    expect((await setStatus(shipmentId, "LIVRE")).ok).toBe(true);
    expect(await orderStatus(orderId)).toBe("LIVREE");
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
    expect(await saleMovements(productId)).toBe(1);
  });

  it("an order already « Expédiée » by hand is not shipped twice", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    const shipmentId = await manualShipment(orderId);
    await updateOrderStatusAction(fd({ id: orderId, status: "EN_PREPARATION" }));
    await updateOrderStatusAction(fd({ id: orderId, status: "EXPEDIEE" }));
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });

    expect((await setStatus(shipmentId, "EN_TRANSIT")).ok).toBe(true);
    expect((await setStatus(shipmentId, "LIVRE")).ok).toBe(true);
    expect(await orderStatus(orderId)).toBe("LIVREE");
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
    expect(await saleMovements(productId)).toBe(1);
  });

  it("concurrent status updates and a concurrent manual « Expédiée » deduct stock exactly once", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    await updateOrderStatusAction(fd({ id: orderId, status: "EN_PREPARATION" }));
    const shipmentId = await manualShipment(orderId);

    await Promise.all([
      setStatus(shipmentId, "EN_TRANSIT"),
      setStatus(shipmentId, "LIVRE"),
      updateOrderStatusAction(fd({ id: orderId, status: "EXPEDIEE" })),
    ]);
    expect(["EXPEDIEE", "LIVREE"]).toContain(await orderStatus(orderId));
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
    expect(await saleMovements(productId)).toBe(1);
  });

  it("the same status sent twice is refused the second time and changes nothing", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    const shipmentId = await manualShipment(orderId);
    expect((await setStatus(shipmentId, "EN_TRANSIT")).ok).toBe(true);
    expect((await setStatus(shipmentId, "EN_TRANSIT")).ok).toBe(false);
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
    expect(await saleMovements(productId)).toBe(1);
  });

  it("« Échec » and « Annulé » never change the order's status; « Retourné » moves it to « Retour » without restocking", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const a = await seedOrder(1);
    const failed = await manualShipment(a.orderId);
    expect((await setStatus(failed, "ECHEC", "Client injoignable")).ok).toBe(true);
    expect(await orderStatus(a.orderId)).toBe("CONFIRMEE");
    expect(await stock(a.productId)).toEqual({ onHand: 10, reserved: 1 });

    const cancelled = await manualShipment(a.orderId);
    expect((await setStatus(cancelled, "ANNULE")).ok).toBe(true);
    expect(await orderStatus(a.orderId)).toBe("CONFIRMEE");

    const returned = await manualShipment(a.orderId);
    expect((await setStatus(returned, "EN_TRANSIT")).ok).toBe(true); // ships the order
    expect((await setStatus(returned, "RETOURNE")).ok).toBe(true);
    expect(await orderStatus(a.orderId)).toBe("RETOUR");
    expect(await stock(a.productId)).toEqual({ onHand: 9, reserved: 0 }); // only a physical return / inspection restocks
  });

  it("with packing verification required, an unpacked order is refused and nothing changes", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    const shipmentId = await manualShipment(orderId); // created while the setting was off
    await prisma.businessSettings.upsert({ where: { tenantId: "default" }, update: { packingVerificationRequired: true }, create: { packingVerificationRequired: true } });

    const r = await setStatus(shipmentId, "LIVRE");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/emballage/i);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe("EN_ATTENTE");
    expect(await orderStatus(orderId)).toBe("CONFIRMEE");
    expect(await stock(productId)).toEqual({ onHand: 10, reserved: 1 });
  });

  it("a carrier sync reporting « in transit » ships a « Confirmée » order", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const providerId = await apiProvider();
    const { orderId, productId } = await seedOrder(1);
    const created = await createShipmentViaProviderAction(fd({ orderId, providerId }));
    if (!created.ok) throw new Error("setup failed");
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: created.data.id } });
    carrier.shipments.get(shipment.externalId!)!.status = "in_transit";

    const r = await syncShipmentStatusAction(fd({ shipmentId: shipment.id }));
    expect(r.ok && r.data.outcome).toBe("updated");
    expect(await orderStatus(orderId)).toBe("EXPEDIEE");
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
  });
});

describe("S1 — manual failures, carrier cancellations, one active parcel", () => {
  it("a manual « Échec » requires a reason (server-side)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId } = await seedOrder(1);
    const shipmentId = await manualShipment(orderId);
    const none = await setStatus(shipmentId, "ECHEC");
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/raison/i);
    expect((await setStatus(shipmentId, "ECHEC", "  ab ")).ok).toBe(false);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).status).toBe("EN_ATTENTE");
    expect((await setStatus(shipmentId, "ECHEC", "Adresse introuvable")).ok).toBe(true);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } })).failedReason).toBe("Adresse introuvable");
  });

  it("a manual « Échec » (and its frozen cost) survives the delete action and a later carrier shipment", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const providerId = await apiProvider();
    const { orderId } = await seedOrder(1);
    const manualId = await manualShipment(orderId);
    await prisma.shippingProvider.updateMany({ where: { type: "MANUEL" }, data: { failureCost: 15 } });
    expect((await setStatus(manualId, "ECHEC", "Client absent")).ok).toBe(true);

    const del = await deleteFailedShipmentAction(fd({ shipmentId: manualId }));
    expect(del.ok).toBe(false);

    // A failed API attempt IS still cleaned up when the real shipment is created.
    carrier.forceCreateStatus = 500;
    await createShipmentViaProviderAction(fd({ orderId, providerId }));
    carrier.forceCreateStatus = undefined;
    expect(await prisma.shipment.count({ where: { orderId, status: "ECHEC", externalId: null, provider: { type: "API" } } })).toBe(1);
    const created = await createShipmentViaProviderAction(fd({ orderId, providerId }));
    expect(created.ok).toBe(true);

    const manual = await prisma.shipment.findUniqueOrThrow({ where: { id: manualId } });
    expect(manual).toMatchObject({ status: "ECHEC", failedReason: "Client absent" });
    expect(Number(manual.cost)).toBe(15);
    expect(manual.costFinalizedAt).not.toBeNull();
    expect(await prisma.shipment.count({ where: { orderId, status: "ECHEC", provider: { type: "API" } } })).toBe(0);
  });

  it("a carrier parcel can't be set « Annulé » from the local dropdown", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const providerId = await apiProvider();
    const { orderId } = await seedOrder(1);
    const created = await createShipmentViaProviderAction(fd({ orderId, providerId }));
    if (!created.ok) throw new Error("setup failed");

    const r = await setStatus(created.data.id, "ANNULE");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/transporteur/);
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: created.data.id } })).status).toBe("EN_ATTENTE");
  });

  it("one active parcel per order across carriers — history allowed, concurrent creates serialized", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId } = await seedOrder(1);
    const a = await manualProvider("Livreur A");
    const b = await manualProvider("Livreur B");

    const first = await manualShipment(orderId, a);
    const second = await createShipmentAction(fd({ orderId, providerId: b }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/Livreur A/);

    expect((await setStatus(first, "ANNULE")).ok).toBe(true);
    const [x, y] = await Promise.all([
      createShipmentAction(fd({ orderId, providerId: a })),
      createShipmentAction(fd({ orderId, providerId: b })),
    ]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.shipment.count({ where: { orderId, status: { in: ["EN_ATTENTE", "EN_TRANSIT"] } } })).toBe(1);
    expect(await prisma.shipment.count({ where: { orderId } })).toBe(2); // the cancelled one stays as history
  });
});

describe("S1 — re-shipping an order whose goods came back", () => {
  /** Ships the order (1 unit) through a parcel that then comes back. Staff
   * had already moved the order to « Échec » (the historical retry loop), so
   * the late « Retourné » leaves it there (ECHEC can't become RETOUR) — the
   * re-ship guard below is what stops a second parcel. */
  async function shippedThenReturned(productId: string, orderId: string, opts: { restock: boolean }) {
    const first = await manualShipment(orderId);
    expect((await setStatus(first, "EN_TRANSIT")).ok).toBe(true);
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "ECHEC" }))).ok).toBe(true);
    expect((await setStatus(first, "RETOURNE")).ok).toBe(true);
    expect(await orderStatus(orderId)).toBe("ECHEC");
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
    if (opts.restock) {
      const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
      const r = await confirmPhysicalReturnAction({
        orderId,
        idempotencyKey: randomUUID(),
        lines: [{ orderItemId: item.id, quantitySellable: 1, quantityDamaged: 0 }],
      });
      expect(r.ok).toBe(true);
      expect(await stock(productId)).toEqual({ onHand: 10, reserved: 0 });
    }
    // The pre-existing retry loop: (EXPEDIEE → ECHEC above) → EN_PREPARATION.
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "EN_PREPARATION" }))).ok).toBe(true);
  }

  it("units back in stock: a new parcel on the same order is refused, so stock can't be overstated", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    await shippedThenReturned(productId, orderId, { restock: true });

    const again = await createShipmentAction(fd({ orderId, providerId: await manualProvider("Autre livreur") }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toMatch(/nouvelle commande/);
    const manualReship = await updateOrderStatusAction(fd({ id: orderId, status: "EXPEDIEE" }));
    expect(manualReship.ok).toBe(false);

    // Invariant: every unit is either on the shelf or with the customer — never both.
    expect(await stock(productId)).toEqual({ onHand: 10, reserved: 0 });
    expect(await prisma.shipment.count({ where: { orderId, status: { in: ["EN_ATTENTE", "EN_TRANSIT", "LIVRE"] } } })).toBe(0);
  });

  it("a returned parcel not yet received blocks re-shipping too (its reception would restock later)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    await shippedThenReturned(productId, orderId, { restock: false });

    const again = await createShipmentAction(fd({ orderId, providerId: await manualProvider("Autre livreur") }));
    expect(again.ok).toBe(false);
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
  });

  it("a failed parcel that never came back can still be retried (the historical ECHEC loop)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    const first = await manualShipment(orderId);
    expect((await setStatus(first, "EN_TRANSIT")).ok).toBe(true);
    expect((await setStatus(first, "ECHEC", "Client injoignable")).ok).toBe(true);
    await updateOrderStatusAction(fd({ id: orderId, status: "ECHEC" }));
    await updateOrderStatusAction(fd({ id: orderId, status: "EN_PREPARATION" }));

    const retry = await manualShipment(orderId);
    expect((await setStatus(retry, "LIVRE")).ok).toBe(true);
    expect(await orderStatus(orderId)).toBe("LIVREE");
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
    expect(await saleMovements(productId)).toBe(1);
  });
});

describe("S1 — an old failed parcel can't come back to life next to an active one", () => {
  it("reactivating an ECHEC row while another parcel is in flight is refused: no second active row, no stock move", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    const old = await manualShipment(orderId, await manualProvider("Livreur A"));
    expect((await setStatus(old, "ECHEC", "Client injoignable")).ok).toBe(true);
    const current = await manualShipment(orderId, await manualProvider("Livreur B"));
    expect(await stock(productId)).toEqual({ onHand: 10, reserved: 1 });

    for (const target of ["EN_TRANSIT", "LIVRE"]) {
      const r = await setStatus(old, target);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/autre expédition est déjà en cours/i);
    }

    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: old } })).status).toBe("ECHEC");
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: current } })).status).toBe("EN_ATTENTE");
    expect(await prisma.shipment.count({ where: { orderId, status: { in: ["EN_ATTENTE", "EN_TRANSIT"] } } })).toBe(1);
    expect(await orderStatus(orderId)).toBe("CONFIRMEE");
    expect(await stock(productId)).toEqual({ onHand: 10, reserved: 1 });
    expect(await saleMovements(productId)).toBe(0);
  });

  it("with no other active parcel, the ECHEC row may still move again (the historical retry)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId } = await seedOrder(1);
    const only = await manualShipment(orderId);
    expect((await setStatus(only, "ECHEC", "Client absent")).ok).toBe(true);
    expect((await setStatus(only, "EN_TRANSIT")).ok).toBe(true);
    expect(await orderStatus(orderId)).toBe("EXPEDIEE");
  });
});

describe("S1 — status-change audit keeps the failure reasons", () => {
  it("`shipment.status_changed` records the old and new failedReason", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId } = await seedOrder(1);
    const shipmentId = await manualShipment(orderId);

    expect((await setStatus(shipmentId, "ECHEC", "Adresse introuvable")).ok).toBe(true);
    expect((await setStatus(shipmentId, "EN_TRANSIT")).ok).toBe(true);
    expect((await setStatus(shipmentId, "ECHEC", "Client a refusé le colis")).ok).toBe(true);

    const audits = await prisma.auditEvent.findMany({
      where: { action: "shipment.status_changed", entityId: shipmentId },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(3);
    expect(audits[0].previousValue).toMatchObject({ status: "EN_ATTENTE", failedReason: null });
    expect(audits[0].newValue).toMatchObject({ status: "ECHEC", failedReason: "Adresse introuvable" });
    expect(audits[1].previousValue).toMatchObject({ status: "ECHEC", failedReason: "Adresse introuvable" });
    // The column is overwritten by the second failure — the audit keeps both.
    expect(audits[2].previousValue).toMatchObject({ status: "EN_TRANSIT", failedReason: "Adresse introuvable" });
    expect(audits[2].newValue).toMatchObject({ status: "ECHEC", failedReason: "Client a refusé le colis" });
  });

  it("a carrier sync's `shipment.status_changed` carries failedReason too", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const providerId = await apiProvider();
    const { orderId } = await seedOrder(1);
    const created = await createShipmentViaProviderAction(fd({ orderId, providerId }));
    if (!created.ok) throw new Error("setup failed");
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: created.data.id } });
    carrier.shipments.get(shipment.externalId!)!.status = "in_transit";

    expect((await syncShipmentStatusAction(fd({ shipmentId: shipment.id }))).ok).toBe(true);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "shipment.status_changed", entityId: shipment.id } });
    expect(audit.previousValue).toEqual({ status: "EN_ATTENTE", failedReason: null });
    expect(audit.newValue).toEqual({ status: "EN_TRANSIT", failedReason: null });
  });
});

describe("C1 — a parcel « Retourné » moves its order to « Retour » (docs/adr/0006, 2026-10-12)", () => {
  const returnMovements = (productId: string) =>
    prisma.inventoryMovement.count({ where: { inventoryItem: { productId }, type: { in: ["RETOUR", "ENDOMMAGE"] } } });
  const returnAudits = (orderId: string) =>
    prisma.auditEvent.findMany({
      where: { action: "order.status_changed", entityId: orderId, metadata: { path: ["reason"], equals: "shipment_returned" } },
    });

  it("manual « Retourné »: order RETOUR, audited once, one alert, no stock movement, payment untouched", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId, productId } = await seedOrder(1);
    const shipmentId = await manualShipment(orderId);
    expect((await setStatus(shipmentId, "EN_TRANSIT")).ok).toBe(true);
    const r = await setStatus(shipmentId, "RETOURNE");
    expect(r.ok).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("RETOUR");
    expect(order.paymentStatus).toBe("EN_ATTENTE");
    expect(await stock(productId)).toEqual({ onHand: 9, reserved: 0 });
    expect(await returnMovements(productId)).toBe(0);
    const audits = await returnAudits(orderId);
    expect(audits).toHaveLength(1);
    expect(audits[0].previousValue).toEqual({ status: "EXPEDIEE" });

    // Replayed event: refused (terminal shipment), nothing applied twice.
    expect((await setStatus(shipmentId, "RETOURNE")).ok).toBe(false);
    expect(await returnAudits(orderId)).toHaveLength(1);
    // One « Commande retournée » alert per recipient (dedupe key per order).
    const alerts = await prisma.notification.findMany({ where: { type: "COMMANDE_RETOURNEE", entityId: orderId } });
    expect(new Set(alerts.map((n) => n.userId)).size).toBe(alerts.length);
  });

  it("a carrier sync reporting « returned » moves the order to RETOUR", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const providerId = await apiProvider();
    const { orderId, productId } = await seedOrder(1);
    const created = await createShipmentViaProviderAction(fd({ orderId, providerId }));
    if (!created.ok) throw new Error("setup failed");
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: created.data.id } });
    carrier.shipments.get(shipment.externalId!)!.status = "in_transit";
    expect((await syncShipmentStatusAction(fd({ shipmentId: shipment.id }))).ok).toBe(true);
    carrier.shipments.get(shipment.externalId!)!.status = "returned";
    const r = await syncShipmentStatusAction(fd({ shipmentId: shipment.id }));
    expect(r.ok && r.data.outcome).toBe("updated");
    expect(await orderStatus(orderId)).toBe("RETOUR");
    expect(await returnMovements(productId)).toBe(0);

    // The same carrier answer again: unchanged, still one audit.
    await syncShipmentStatusAction(fd({ shipmentId: shipment.id }));
    expect(await returnAudits(orderId)).toHaveLength(1);
  });

  it("an order that can't become RETOUR (« Annulée » after a failed delivery) is left unchanged", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { orderId } = await seedOrder(1);
    const shipmentId = await manualShipment(orderId);
    expect((await setStatus(shipmentId, "EN_TRANSIT")).ok).toBe(true);
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "ECHEC" }))).ok).toBe(true);
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "ANNULEE" }))).ok).toBe(true);
    expect((await setStatus(shipmentId, "RETOURNE")).ok).toBe(true);
    expect(await orderStatus(orderId)).toBe("ANNULEE");
    expect(await returnAudits(orderId)).toHaveLength(0);
  });
});
