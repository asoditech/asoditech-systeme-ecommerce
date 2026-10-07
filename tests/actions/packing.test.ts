import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { checkPackingScanAction, validatePackingAction } from "@/actions/packing";
import { createOrderAction, updateOrderStatusAction, cancelOrderAction } from "@/actions/orders";
import { createShipmentAction, createShipmentViaProviderAction, createShipmentsBulkAction, createShippingProviderAction } from "@/actions/delivery";
import { updatePackingVerificationAction } from "@/actions/settings";
import { createShipmentViaProvider } from "@/lib/integrations/delivery/service";
import { listOrdersAwaitingShipment } from "@/lib/queries/delivery";
import { hasPermission } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/session";
import { hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Packing verification (« Emballage » = EN_PREPARATION): exact scan matching,
 * quantities, manual fallback, and the tenant setting that gates shipment
 * creation everywhere.
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

/** Order: T-shirt Noir ×1, T-shirt Blanc ×1, Casquette ×2 — moved to the requested status. */
async function seedOrder(
  target: "NOUVELLE" | "CONFIRMEE" | "EN_PREPARATION" = "EN_PREPARATION",
  as?: "WAREHOUSE" | "MANAGER" | "ADMIN"
) {
  mockCookieStore.clear();
  await loginAsTestUser({ role: "ADMIN" });
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
  const actor = await getCurrentUser();
  if (actor && !hasGlobalLocationAccess(actor.role)) await grantLocationAccess(actor.id, warehouse.id);
  const tshirt = await prisma.product.create({ data: { name: "T-shirt", sku: "TS", price: 100, status: "ACTIF" } });
  const noir = await prisma.productVariation.create({ data: { productId: tshirt.id, sku: "TS-NOIR", attributes: { Couleur: "Noir" }, price: 100 } });
  const blanc = await prisma.productVariation.create({ data: { productId: tshirt.id, sku: "TS-BLANC", attributes: { Couleur: "Blanc" }, price: 100 } });
  const rouge = await prisma.productVariation.create({ data: { productId: tshirt.id, sku: "TS-ROUGE", attributes: { Couleur: "Rouge" }, price: 100 } });
  await prisma.barcode.create({ data: { code: "6111111111111", variationId: noir.id, isPrimary: true } });
  const cap = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50, status: "ACTIF" } });
  for (const v of [noir, blanc, rouge]) await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: v.id, quantityOnHand: 10 } });
  await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: cap.id, quantityOnHand: 10 } });
  const customer = await prisma.customer.create({ data: { fullName: "Sara Amrani" } });
  const created = await createOrderAction({
    customerId: customer.id,
    paymentMethod: "PAIEMENT_LIVRAISON",
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "1 Rue X",
    shippingAddressLine2: "",
    shippingCity: "Rabat",
    shippingRegion: "",
    shippingCountry: "Maroc",
    shippingPhone: "0611223344",
    items: [
      { productId: null, variationId: noir.id, quantity: 1, unitPrice: 100, discount: 0 },
      { productId: null, variationId: blanc.id, quantity: 1, unitPrice: 100, discount: 0 },
      { productId: cap.id, quantity: 2, unitPrice: 50, discount: 0 },
    ],
  });
  if (!created.ok) throw new Error(created.error);
  const orderId = created.data.id;
  const steps = target === "NOUVELLE" ? [] : target === "CONFIRMEE" ? ["CONFIRMEE"] : ["CONFIRMEE", "EN_PREPARATION"];
  for (const status of steps) {
    const r = await updateOrderStatusAction(fd({ id: orderId, status }));
    if (!r.ok) throw new Error(r.error);
  }
  if (as) {
    mockCookieStore.clear();
    const user = await loginAsTestUser({ role: as });
    if (as === "WAREHOUSE" || as === "MANAGER") await grantLocationAccess(user.id, warehouse.id);
  }
  return { orderId, noir, blanc, rouge, cap };
}

const keyOf = (v: { id: string }) => `v:${v.id}`;

async function setPackingRequired(on: boolean) {
  // Direct write (a MANAGER can't change settings); the action itself is tested below as ADMIN.
  await prisma.businessSettings.upsert({ where: { tenantId: "default" }, update: { packingVerificationRequired: on }, create: { packingVerificationRequired: on } });
}

describe("permissions", () => {
  it("orders.pack: OWNER/ADMIN/MANAGER/WAREHOUSE; orders.pack_manual: MANAGER and above only", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "WAREHOUSE"] as const) expect(hasPermission(role, "orders.pack"), role).toBe(true);
    for (const role of ["OWNER", "ADMIN", "MANAGER"] as const) expect(hasPermission(role, "orders.pack_manual"), role).toBe(true);
    expect(hasPermission("WAREHOUSE", "orders.pack_manual")).toBe(false);
    for (const role of ["CONFIRMATION", "DELIVERY", "SUPPORT", "STORE_SELLER"] as const) expect(hasPermission(role, "orders.pack"), role).toBe(false);
  });

  it("a user without orders.pack cannot scan", async () => {
    const { orderId } = await seedOrder("EN_PREPARATION", "ADMIN");
    mockCookieStore.clear();
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(checkPackingScanAction({ orderId, code: "TS-NOIR", scannedKeys: [] })).rejects.toThrow(/non autorisé/i);
  });
});

describe("scan matching — exact barcode / variation SKU / simple SKU only", () => {
  it("accepts the order's units; rejects wrong product, wrong variation, parent SKU, name and partial input", async () => {
    const { orderId, noir, blanc, cap } = await seedOrder("EN_PREPARATION", "WAREHOUSE");
    const scan = (code: string, scannedKeys: string[] = []) => checkPackingScanAction({ orderId, code, scannedKeys });

    expect(await scan("6111111111111")).toMatchObject({ ok: true, data: { key: keyOf(noir) } }); // barcode
    expect(await scan("ts-blanc")).toMatchObject({ ok: true, data: { key: keyOf(blanc), label: "T-shirt — Blanc" } }); // variation SKU, case-insensitive
    expect(await scan("CAP-1")).toMatchObject({ ok: true, data: { key: `p:${cap.id}` } }); // simple product SKU

    expect(await scan("TS-ROUGE")).toEqual({ ok: false, error: "Ce produit ne fait pas partie de cette commande." }); // wrong variation
    expect((await scan("TS")).ok).toBe(false); // parent SKU → 3 variations → ambiguous
    expect(await scan("TS")).toMatchObject({ error: expect.stringMatching(/ambigu/) });
    expect((await scan("T-shirt")).ok).toBe(false); // name never counts
    expect((await scan("TS-NO")).ok).toBe(false); // partial never counts
    expect((await scan("UNKNOWN-1")).ok).toBe(false);
  });

  it("rejects an extra unit: « Quantité déjà complète. »", async () => {
    const { orderId, noir, cap } = await seedOrder("EN_PREPARATION", "WAREHOUSE");
    expect(await checkPackingScanAction({ orderId, code: "TS-NOIR", scannedKeys: [keyOf(noir)] })).toEqual({ ok: false, error: "Quantité déjà complète." });
    expect((await checkPackingScanAction({ orderId, code: "CAP-1", scannedKeys: [`p:${cap.id}`] })).ok).toBe(true); // 2 required
  });

  it("only at the « Emballage » step", async () => {
    const { orderId } = await seedOrder("CONFIRMEE", "ADMIN");
    expect(await checkPackingScanAction({ orderId, code: "TS-NOIR", scannedKeys: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/Emballage/) });
  });
});

describe("validation — re-checked on the server", () => {
  it("incomplete packing is refused; complete packing is recorded as SCAN with an audit event", async () => {
    const { orderId } = await seedOrder("EN_PREPARATION", "WAREHOUSE");
    const user = (await getCurrentUser())!;
    const missing = await validatePackingAction({ orderId, codes: ["TS-NOIR", "CAP-1", "CAP-1"] });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/incomplet.*Blanc 0\/1/) });

    const ok = await validatePackingAction({ orderId, codes: ["6111111111111", "TS-BLANC", "CAP-1", "CAP-1"] });
    expect(ok.ok).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.packedAt).not.toBeNull();
    expect(order.packedById).toBe(user.id);
    expect(order.packingMethod).toBe("SCAN");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.packed", entityId: orderId } });
    expect(audit.metadata).toMatchObject({ scannedUnits: 4 });
    expect((await validatePackingAction({ orderId, codes: ["TS-NOIR"] })).ok).toBe(false); // already verified
  });

  it("never trusts the browser: a wrong or extra code in the list fails the whole validation", async () => {
    const { orderId } = await seedOrder("EN_PREPARATION", "WAREHOUSE");
    expect(await validatePackingAction({ orderId, codes: ["TS-NOIR", "TS-ROUGE", "TS-BLANC", "CAP-1", "CAP-1"] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/TS-ROUGE.*ne fait pas partie/),
    });
    expect(await validatePackingAction({ orderId, codes: ["TS-NOIR", "TS-NOIR", "TS-BLANC", "CAP-1", "CAP-1"] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Quantité déjà complète/),
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).packedAt).toBeNull();
  });

  it("manual fallback: permission + reason required; recorded as MANUAL with the manual lines in the audit", async () => {
    const { orderId, cap } = await seedOrder("EN_PREPARATION", "WAREHOUSE");
    const manual = { keys: [`p:${cap.id}`], reason: "Code-barres illisible" };
    expect(await validatePackingAction({ orderId, codes: ["TS-NOIR", "TS-BLANC"], manual })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/réservée aux responsables/),
    });

    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" });
    expect(await validatePackingAction({ orderId, codes: ["TS-NOIR", "TS-BLANC"], manual: { ...manual, reason: " " } })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/motif/),
    });
    expect((await validatePackingAction({ orderId, codes: ["TS-NOIR", "TS-BLANC"], manual })).ok).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.packingMethod).toBe("MANUAL");
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "order.packed", entityId: orderId } });
    expect(audit.metadata).toMatchObject({ manualLines: ["Casquette"], reason: "Code-barres illisible", scannedUnits: 2 });
  });
});

describe("packing is cleared when the order goes back", () => {
  it("cancel and reopen clear packedAt", async () => {
    const { orderId } = await seedOrder("EN_PREPARATION", "ADMIN");
    expect((await validatePackingAction({ orderId, codes: ["TS-NOIR", "TS-BLANC", "CAP-1", "CAP-1"] })).ok).toBe(true);
    expect((await cancelOrderAction(fd({ id: orderId, reason: "Client absent" }))).ok).toBe(true);
    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: "ANNULEE", packedAt: null, packedById: null, packingMethod: null });

    // Even if a stale value existed, reopening clears it again.
    await prisma.order.update({ where: { id: orderId }, data: { packedAt: new Date() } });
    expect((await updateOrderStatusAction(fd({ id: orderId, status: "NOUVELLE" }))).ok).toBe(true);
    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: "NOUVELLE", packedAt: null });
  });
});

describe("shipment eligibility — « Vérification de l'emballage obligatoire »", () => {
  async function manualProvider() {
    const p = await createShippingProviderAction(fd({ name: "Livreur interne", type: "MANUEL" }));
    if (!p.ok) throw new Error(p.error);
    return p.data.id;
  }

  it("setting OFF (default): today's behaviour — a confirmed order is in « À expédier » and can be shipped", async () => {
    const { orderId } = await seedOrder("CONFIRMEE", "ADMIN");
    expect((await listOrdersAwaitingShipment()).orders.map((o) => o.id)).toContain(orderId);
    const providerId = await manualProvider();
    expect((await createShipmentAction(fd({ orderId, providerId }))).ok).toBe(true);
  });

  it("setting ON: confirmed and unpacked orders are not shippable anywhere; a packed order is", async () => {
    await setPackingRequired(true);
    const confirmed = await seedOrder("CONFIRMEE", "ADMIN");
    const providerId = await manualProvider();
    const apiProvider = await prisma.shippingProvider.create({ data: { name: "API", type: "API", providerKey: "ozonexpress" } });

    expect((await listOrdersAwaitingShipment()).orders.map((o) => o.id)).not.toContain(confirmed.orderId);
    expect(await createShipmentAction(fd({ orderId: confirmed.orderId, providerId }))).toMatchObject({
      ok: false,
      error: "L'emballage de cette commande n'a pas encore été vérifié.",
    });

    // Same order moved to « Emballage » but not verified yet.
    expect((await updateOrderStatusAction(fd({ id: confirmed.orderId, status: "EN_PREPARATION" }))).ok).toBe(true);
    const orderId = confirmed.orderId;
    expect((await listOrdersAwaitingShipment()).orders.map((o) => o.id)).not.toContain(orderId);
    expect((await createShipmentAction(fd({ orderId, providerId }))).ok).toBe(false);
    expect((await createShipmentViaProviderAction(fd({ orderId, providerId: apiProvider.id }))).ok).toBe(false);
    const bulk = await createShipmentsBulkAction(fd({ providerId: apiProvider.id, orderIds: orderId }));
    expect(bulk.ok && bulk.data.results[0]).toMatchObject({ ok: false, error: "L'emballage de cette commande n'a pas encore été vérifié." });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { customer: true } });
    await expect(createShipmentViaProvider({ order, providerId: apiProvider.id, updatedById: order.createdById!, notes: null })).rejects.toThrow(
      /emballage/
    );
    // A manual « Expédiée » cannot bypass it either.
    expect(await updateOrderStatusAction(fd({ id: orderId, status: "EXPEDIEE" }))).toMatchObject({ ok: false, error: expect.stringMatching(/emballage/) });

    // Packed → eligible.
    expect((await validatePackingAction({ orderId, codes: ["TS-NOIR", "TS-BLANC", "CAP-1", "CAP-1"] })).ok).toBe(true);
    expect((await listOrdersAwaitingShipment()).orders.map((o) => o.id)).toContain(orderId);
    expect((await createShipmentAction(fd({ orderId, providerId }))).ok).toBe(true);
  });

  it("the setting defaults to off; only settings.manage may change it, and the change is audited", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    expect((await prisma.businessSettings.findFirst())?.packingVerificationRequired ?? false).toBe(false);
    await expect(updatePackingVerificationAction(fd({ packingVerificationRequired: "true" }))).rejects.toThrow(/non autorisé/i);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect((await updatePackingVerificationAction(fd({ packingVerificationRequired: "true" }))).ok).toBe(true);
    expect((await prisma.businessSettings.findFirstOrThrow()).packingVerificationRequired).toBe(true);
    expect(await prisma.auditEvent.count({ where: { action: "settings.updated" } })).toBe(1);
  });
});
