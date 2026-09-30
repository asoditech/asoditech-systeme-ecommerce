import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { searchProductsForOrderAction } from "@/actions/orders";
import { updateProductOperationalSettingsAction, updateVariationOperationalSettingsAction } from "@/actions/products";
import { updateUserRoleAction } from "@/actions/users";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { listAuditJournal } from "@/lib/queries/audit";
import { getCurrentUser } from "@/lib/auth/session";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Phase 4C — final access hardening (docs/adr/0044-access-hardening-final.md).
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** A product (cost 120) with one active variation (cost 80). */
async function seedProductWithVariation() {
  const product = await prisma.product.create({ data: { name: "Basket Pro", sku: "BASKET-PRO", price: 300, status: "ACTIF", cost: 120 } });
  const variation = await prisma.productVariation.create({
    data: { productId: product.id, sku: "BASKET-PRO-42", attributes: { Taille: "42" }, cost: 80, price: 310 },
  });
  return { product, variation };
}

// ---------------------------------------------------------------------------
// 1. Order product search
// ---------------------------------------------------------------------------

describe("searchProductsForOrderAction — purchase cost exposure", () => {
  it("without finance.view (CONFIRMATION): product AND variation cost are null, no value anywhere in the payload", async () => {
    await seedProductWithVariation();
    await loginAsTestUser({ role: "CONFIRMATION" }); // orders.create, no finance.view
    const results = await searchProductsForOrderAction("Basket");
    expect(results).toHaveLength(1);
    expect(results[0]!.cost).toBeNull();
    expect(results[0]!.variations).toHaveLength(1);
    expect(results[0]!.variations[0]!.cost).toBeNull();
    const json = JSON.stringify(results);
    expect(json).not.toContain("120");
    expect(json).not.toMatch(/"cost":"80/);
    // the selling data the order form needs is untouched
    expect(results[0]!.price).toBe("300");
    expect(results[0]!.variations[0]!.price).toBe("310");
  });

  it("with finance.view (MANAGER): unchanged — both costs returned", async () => {
    await seedProductWithVariation();
    await loginAsTestUser({ role: "MANAGER" });
    const results = await searchProductsForOrderAction("Basket");
    expect(results[0]!.cost).toBe("120");
    expect(results[0]!.variations[0]!.cost).toBe("80");
  });
});

// ---------------------------------------------------------------------------
// 2. Audit trail — no purchase-cost values recorded; journal loads no payloads
// ---------------------------------------------------------------------------

describe("product cost in audit events", () => {
  const lastProductUpdate = () =>
    prisma.auditEvent.findFirstOrThrow({ where: { action: "product.updated" }, orderBy: { createdAt: "desc" } });

  it("operational settings: records costChanged, never the old/new cost values; other fields kept", async () => {
    const { product } = await seedProductWithVariation();
    await loginAsTestUser({ role: "MANAGER" });
    expect((await updateProductOperationalSettingsAction(formData({ id: product.id, cost: "135.50", lowStockThreshold: "7" }))).ok).toBe(true);

    const e = await lastProductUpdate();
    expect(e.newValue).toMatchObject({ costChanged: true, lowStockThreshold: 7 });
    expect(e.previousValue).toMatchObject({ lowStockThreshold: 5 });
    for (const payload of [e.previousValue, e.newValue, e.metadata]) {
      const json = JSON.stringify(payload ?? {});
      expect(json).not.toMatch(/"cost"/);
      expect(json).not.toContain("135.5");
      expect(json).not.toContain("120");
    }
    // the cost itself was of course saved
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).cost)).toBe(135.5);
  });

  it("costChanged is false when the cost did not change", async () => {
    const { product } = await seedProductWithVariation();
    await loginAsTestUser({ role: "MANAGER" });
    await updateProductOperationalSettingsAction(formData({ id: product.id, cost: "120", lowStockThreshold: "9" }));
    expect((await lastProductUpdate()).newValue).toMatchObject({ costChanged: false, lowStockThreshold: 9 });
  });

  it("variation cost editor: records the variation and costChanged, never the values", async () => {
    const { variation } = await seedProductWithVariation();
    await loginAsTestUser({ role: "MANAGER" });
    expect((await updateVariationOperationalSettingsAction(formData({ id: variation.id, cost: "91" }))).ok).toBe(true);
    const e = await lastProductUpdate();
    expect(e.newValue).toEqual({ variation: "BASKET-PRO-42", costChanged: true });
    expect(e.previousValue).toEqual({ variation: "BASKET-PRO-42" });
  });

  it("the audit journal never loads event payloads — a historical cost-bearing event stays unreadable there", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    // A pre-Phase-4C event, exactly as the old code recorded it (not rewritten).
    await prisma.auditEvent.create({
      data: {
        actorType: "USER",
        action: "product.updated",
        entityType: "Product",
        entityId: "legacy-product",
        previousValue: { cost: "120.00", trackInventory: true, lowStockThreshold: 5 },
        newValue: { cost: "99.00", trackInventory: true, lowStockThreshold: 5 },
        ipAddress: "10.0.0.1",
      },
    });
    const { items, total } = await listAuditJournal((await getCurrentUser())!, { page: 1 });
    expect(total).toBeGreaterThan(0);
    const legacy = items.find((i) => i.entityId === "legacy-product")!;
    expect(legacy).toBeDefined();
    expect(Object.keys(legacy).sort()).toEqual(["action", "actorType", "actorUser", "createdAt", "entityId", "entityType", "id"]);
    expect(JSON.stringify(items)).not.toContain("99.00");
    // still stored untouched (append-only log — never rewritten)
    const raw = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: "legacy-product" } });
    expect(raw.newValue).toMatchObject({ cost: "99.00" });
  });

  it("the journal's filters still work (search + category)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await prisma.auditEvent.createMany({
      data: [
        { actorType: "USER", action: "product.updated", entityType: "Product", entityId: "p1" },
        { actorType: "USER", action: "user.role_changed", entityType: "User", entityId: "u1" },
      ],
    });
    const viewer = (await getCurrentUser())!;
    const byText = await listAuditJournal(viewer, { q: "role_changed" });
    expect(byText.items.map((i) => i.entityId)).toEqual(["u1"]);
    const byCategory = await listAuditJournal(viewer, { category: "utilisateurs" });
    expect(byCategory.items.some((i) => i.entityId === "u1")).toBe(true);
    expect(byCategory.items.some((i) => i.entityId === "p1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Existing-user role change to STORE_SELLER
// ---------------------------------------------------------------------------

describe("updateUserRoleAction — STORE_SELLER gated by tenant mode", () => {
  const changeRole = (id: string, role: string) => updateUserRoleAction(formData({ id, role }));

  it("ONLINE_ONLY: refused server-side (bypassing the UI), role unchanged; other role changes still work", async () => {
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION" });

    const r = await changeRole(target.id, "STORE_SELLER");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/En ligne \+ Magasin/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe("CONFIRMATION");

    expect((await changeRole(target.id, "SUPPORT")).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe("SUPPORT");
  });

  it("ONLINE_AND_OFFLINE: allowed, as before", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "ADMIN" });
    const target = await createTestUser({ role: "CONFIRMATION" });
    expect((await changeRole(target.id, "STORE_SELLER")).ok).toBe(true);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe("STORE_SELLER");
  });
});

// ---------------------------------------------------------------------------
// STORE_SELLER cannot reach another store — server-side, not just the pickers
// ---------------------------------------------------------------------------

describe("STORE_SELLER cross-store denial (server actions called directly)", () => {
  async function seedTwoStores() {
    const mk = async (tag: string, onHand: number) => {
      const wh = await prisma.warehouse.create({ data: { name: `Magasin ${tag}`, type: "MAGASIN" } });
      const ch = await prisma.salesChannel.create({ data: { name: `Boutique ${tag}`, kind: "OFFLINE" } });
      await prisma.salesChannelLocation.create({ data: { salesChannelId: ch.id, warehouseId: wh.id } });
      return { wh, ch, onHand };
    };
    const a = await mk("A", 10);
    const b = await mk("B", 5);
    const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 250, status: "ACTIF", cost: 100 } });
    for (const s of [a, b]) {
      await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: s.ch.id } });
      await prisma.inventoryItem.create({ data: { warehouseId: s.wh.id, productId: product.id, quantityOnHand: s.onHand } });
    }
    return { a, b, product };
  }
  const sale = (ch: string, wh: string, productId: string) => ({
    salesChannelId: ch,
    warehouseId: wh,
    idempotencyKey: crypto.randomUUID(),
    lines: [{ productId, quantity: 1 }],
    payments: [{ method: "ESPECES" as const, amount: 250 }],
  });

  it("a Store-A seller cannot sell from Store B, nor return a Store-B sale; stock B untouched", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const { a, b, product } = await seedTwoStores();

    // a Store-B sale made by an admin
    await loginAsTestUser({ role: "ADMIN" });
    const bSale = await createSaleAction(sale(b.ch.id, b.wh.id, product.id));
    expect(bSale.ok).toBe(true);
    if (!bSale.ok) return;
    const bLine = await prisma.saleLine.findFirstOrThrow({ where: { saleId: bSale.data.id } });

    mockCookieStore.clear();
    const seller = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(seller.id, a.ch.id);
    await grantLocationAccess(seller.id, a.wh.id);

    // own store works
    expect((await createSaleAction(sale(a.ch.id, a.wh.id, product.id))).ok).toBe(true);
    // Store B's channel / location, called directly
    await expect(createSaleAction(sale(b.ch.id, b.wh.id, product.id))).rejects.toThrow(/non autorisé/i);
    // Store B's sale is "not found" for this seller
    const ret = await createSaleReturnAction({
      saleId: bSale.data.id,
      idempotencyKey: crypto.randomUUID(),
      lines: [{ saleLineId: bLine.id, quantitySellable: 1, quantityDamaged: 0 }],
    });
    expect(ret.ok).toBe(false);
    const stockB = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: b.wh.id } });
    expect(stockB.quantityOnHand).toBe(4); // only the admin's own sale
  });
});
