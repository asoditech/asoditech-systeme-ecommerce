import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createProductAction,
  updateProductAction,
  createProductVariationAction,
  updateVariationDetailsAction,
  updateProductOperationalSettingsAction,
  updateVariationOperationalSettingsAction,
  backfillProductCostSnapshotsAction,
} from "@/actions/products";
import { lookupSellableUnitsAction } from "@/actions/catalog";
import { runAiToolAction } from "@/actions/ai";
import { inviteUserAction } from "@/actions/invitations";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Phase 4B — product cost hardening + store-seller follow-ups
 * (docs/adr/0043-product-cost-hardening.md). Asserted at the server boundary.
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

/** A logged-in user with products.create/edit but NOT finance.view (WAREHOUSE + GRANTs). */
async function loginNoFinanceEditor() {
  const u = await loginAsTestUser({ role: "WAREHOUSE" });
  await prisma.userPermissionOverride.createMany({
    data: [
      { userId: u.id, permission: "products.create", effect: "GRANT" },
      { userId: u.id, permission: "products.edit", effect: "GRANT" },
    ],
  });
  return u;
}

const costOf = async (id: string) => {
  const p = await prisma.product.findUniqueOrThrow({ where: { id } });
  return p.cost === null ? null : Number(p.cost);
};
const variationCostOf = async (id: string) => {
  const v = await prisma.productVariation.findUniqueOrThrow({ where: { id } });
  return v.cost === null ? null : Number(v.cost);
};

async function seedProduct(cost: number | null = 120) {
  return prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 300, status: "ACTIF", cost } });
}

// ---------------------------------------------------------------------------
// Product cost — a user without finance.view can neither set nor change it
// ---------------------------------------------------------------------------

describe("product cost writes without finance.view", () => {
  it("createProductAction ignores a submitted cost", async () => {
    await loginNoFinanceEditor();
    const r = await createProductAction(formData({ name: "Sac", sku: "SAC-1", price: "100", status: "ACTIF", cost: "42" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await costOf(r.data.id)).toBeNull();
  });

  it("updateProductAction leaves the stored cost untouched — whether a cost is submitted or omitted", async () => {
    const product = await seedProduct(120);
    await loginNoFinanceEditor();
    const withCost = await updateProductAction(
      formData({ id: product.id, name: "Basket v2", sku: "BASKET-1", price: "310", status: "ACTIF", cost: "1" })
    );
    expect(withCost.ok).toBe(true);
    expect(await costOf(product.id)).toBe(120);
    // the form without the field (what the hidden input now submits) must not wipe it either
    const omitted = await updateProductAction(formData({ id: product.id, name: "Basket v3", sku: "BASKET-1", price: "320", status: "ACTIF" }));
    expect(omitted.ok).toBe(true);
    expect(await costOf(product.id)).toBe(120);
    // the rest of the update still applies
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).price)).toBe(320);
  });

  it("operational settings: cost ignored, the other fields still saved", async () => {
    const product = await seedProduct(120);
    await loginNoFinanceEditor();
    const r = await updateProductOperationalSettingsAction(
      formData({ id: product.id, cost: "5", lowStockThreshold: "9", trackInventory: "on" })
    );
    expect(r.ok).toBe(true);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(Number(after.cost)).toBe(120);
    expect(after.lowStockThreshold).toBe(9);
  });

  it("variations: create stores no cost, details update leaves it, the inline cost editor is refused", async () => {
    const product = await seedProduct(120);
    const existing = await prisma.productVariation.create({
      data: { productId: product.id, sku: "BASKET-1-42", attributes: { Taille: "42" }, cost: 80 },
    });
    await loginNoFinanceEditor();

    const created = await createProductVariationAction(
      formData({ productId: product.id, sku: "BASKET-1-43", attributes: JSON.stringify({ Taille: "43" }), cost: "33" })
    );
    expect(created.ok).toBe(true);
    const v43 = await prisma.productVariation.findFirstOrThrow({ where: { sku: "BASKET-1-43" } });
    expect(v43.cost).toBeNull();

    const details = await updateVariationDetailsAction(formData({ id: existing.id, cost: "1", isActive: "on" }));
    expect(details.ok).toBe(true);
    expect(await variationCostOf(existing.id)).toBe(80);

    await expect(updateVariationOperationalSettingsAction(formData({ id: existing.id, cost: "1" }))).rejects.toThrow(/non autorisé/i);
    expect(await variationCostOf(existing.id)).toBe(80);
  });

  it("the historical cost-snapshot backfill is refused", async () => {
    const product = await seedProduct(120);
    await loginNoFinanceEditor();
    await expect(backfillProductCostSnapshotsAction(formData({ productId: product.id }))).rejects.toThrow(/non autorisé/i);
  });
});

describe("product cost writes WITH finance.view — unchanged behaviour", () => {
  it("MANAGER sets, changes and clears the cost exactly as before", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const r = await createProductAction(formData({ name: "Sac", sku: "SAC-1", price: "100", status: "ACTIF", cost: "42" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await costOf(r.data.id)).toBe(42);

    await updateProductAction(formData({ id: r.data.id, name: "Sac", sku: "SAC-1", price: "100", status: "ACTIF", cost: "50" }));
    expect(await costOf(r.data.id)).toBe(50);
    // an empty cost still clears it for a finance user (pre-existing semantics)
    await updateProductAction(formData({ id: r.data.id, name: "Sac", sku: "SAC-1", price: "100", status: "ACTIF" }));
    expect(await costOf(r.data.id)).toBeNull();
  });

  it("MANAGER uses the inline variation cost editor and operational settings", async () => {
    const product = await seedProduct(120);
    const v = await prisma.productVariation.create({ data: { productId: product.id, sku: "BASKET-1-42", attributes: { Taille: "42" }, cost: 80 } });
    await loginAsTestUser({ role: "MANAGER" });
    expect((await updateVariationOperationalSettingsAction(formData({ id: v.id, cost: "85" }))).ok).toBe(true);
    expect(await variationCostOf(v.id)).toBe(85);
    expect((await updateProductOperationalSettingsAction(formData({ id: product.id, cost: "125", lowStockThreshold: "5" }))).ok).toBe(true);
    expect(await costOf(product.id)).toBe(125);
  });
});

// ---------------------------------------------------------------------------
// Reception search — no cost in the response without finance.view
// ---------------------------------------------------------------------------

describe("lookupSellableUnitsAction cost exposure", () => {
  beforeEach(async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE"); // catalogIdentity capability
  });

  it("a user without finance.view gets cost: null (and no cost value anywhere in the payload)", async () => {
    await seedProduct(120);
    await loginAsTestUser({ role: "WAREHOUSE" }); // products.view, purchases.create — no finance.view
    const units = await lookupSellableUnitsAction({ query: "BASKET" });
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) expect(u.cost).toBeNull();
    expect(JSON.stringify(units)).not.toContain("120");
    expect(units[0]).toMatchObject({ sku: "BASKET-1", price: 300 });
  });

  it("a finance.view holder keeps receiving the cost", async () => {
    await seedProduct(120);
    await loginAsTestUser({ role: "MANAGER" });
    const units = await lookupSellableUnitsAction({ query: "BASKET" });
    expect(units[0]?.cost).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// AI low-stock tool — same location scope as the dashboard KPI
// ---------------------------------------------------------------------------

describe("AI low-stock tool location scope", () => {
  /** A: 1 low item · B: 2 low items · C (inactive): 1 low item. */
  async function seedLowStock() {
    const p = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 300, status: "ACTIF", lowStockThreshold: 5 } });
    const q = await prisma.product.create({ data: { name: "Sac", sku: "SAC-1", price: 100, status: "ACTIF", lowStockThreshold: 5 } });
    const a = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    const b = await prisma.warehouse.create({ data: { name: "B" } });
    const c = await prisma.warehouse.create({ data: { name: "C", isActive: false } });
    await prisma.inventoryItem.create({ data: { warehouseId: a.id, productId: p.id, quantityOnHand: 1 } });
    await prisma.inventoryItem.create({ data: { warehouseId: b.id, productId: p.id, quantityOnHand: 2 } });
    await prisma.inventoryItem.create({ data: { warehouseId: b.id, productId: q.id, quantityOnHand: 0 } });
    await prisma.inventoryItem.create({ data: { warehouseId: c.id, productId: q.id, quantityOnHand: 1 } });
    return { a, b, c };
  }
  const ask = async () => {
    const r = await runAiToolAction("low-stock");
    if (!r.ok) throw new Error(r.error);
    return r.answer;
  };

  it("a scoped user sees only their assigned location(s)", async () => {
    const { a, b } = await seedLowStock();
    const u = await loginAsTestUser({ role: "MANAGER" }); // ai.use + inventory.view
    await grantLocationAccess(u.id, a.id);
    expect(await ask()).toMatch(/^1 produit\(s\)/);
    await grantLocationAccess(u.id, b.id);
    expect(await ask()).toMatch(/^3 produit\(s\)/);
  });

  it("a user with zero locations (or only an inactive one) gets no other location's stock", async () => {
    const { c } = await seedLowStock();
    const u = await loginAsTestUser({ role: "MANAGER" });
    expect(await ask()).toMatch(/^Aucun produit/);
    await grantLocationAccess(u.id, c.id);
    expect(await ask()).toMatch(/^Aucun produit/);
  });

  it("OWNER and ADMIN stay tenant-wide", async () => {
    await seedLowStock();
    await loginAsTestUser({ role: "OWNER" });
    expect(await ask()).toMatch(/^4 produit\(s\)/);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect(await ask()).toMatch(/^4 produit\(s\)/);
  });

  it("the tool's permission is unchanged: no inventory.view → refused", async () => {
    await seedLowStock();
    await loginAsTestUser({ role: "CONFIRMATION" }); // ai.use, no inventory.view
    const r = await runAiToolAction("low-stock");
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// STORE_SELLER invitation gating by tenant business mode
// ---------------------------------------------------------------------------

describe("STORE_SELLER invitation gating", () => {
  const invite = (email: string, role: string) => inviteUserAction(formData({ name: "Vendeur", email, role }));

  it("ONLINE_ONLY tenant: the server refuses a STORE_SELLER invitation", async () => {
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "ADMIN" });
    const r = await invite("vendeur-online@test.local", "STORE_SELLER");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/En ligne \+ Magasin/);
    expect(await prisma.invitation.count()).toBe(0);
    // other roles are unaffected
    expect((await invite("confirm@test.local", "CONFIRMATION")).ok).toBe(true);
  });

  it("ONLINE_AND_OFFLINE tenant: unchanged — the invitation is accepted", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "ADMIN" });
    expect((await invite("vendeur-store@test.local", "STORE_SELLER")).ok).toBe(true);
  });
});
