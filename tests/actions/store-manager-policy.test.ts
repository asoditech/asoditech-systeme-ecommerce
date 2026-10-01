import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { PERMISSIONS, PERMISSION_CHANNEL_DOMAIN, ROLE_PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import { computeEffectiveAccess } from "@/lib/auth/effective-access";
import { productCostVisibility } from "@/lib/auth/cost-visibility";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { createSession, getCurrentUser } from "@/lib/auth/session";
import { STORE_MANAGER_DENIES, STORE_MANAGER_PERMISSIONS } from "@/lib/auth/store-manager-profile";
import { inviteUserAction, acceptInvitationAction } from "@/actions/invitations";
import { setUserPermissionOverridesAction } from "@/actions/users";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { adjustInventoryAction } from "@/actions/inventory";
import { createStockTransferAction } from "@/actions/transfers";
import { createStocktakeSessionAction } from "@/actions/stocktakes";
import {
  createReceptionAction,
  recordSupplierPaymentAction,
  createSupplierAction,
  updateSupplierAction,
  updateReceptionDraftAction,
  validateReceptionAction,
  getLatestPurchasePriceAction,
  getUnitPurchaseHistoryAction,
} from "@/actions/purchases";
import { getUnitTraceability } from "@/lib/queries/traceability";
import { createProductAction, updateProductAction } from "@/actions/products";
import { createWarehouseAction } from "@/actions/warehouses";
import { createCustomerAction, updateCustomerAction } from "@/actions/customers";
import { runAiToolAction } from "@/actions/ai";
import { getStockValuationReport } from "@/lib/queries/reports/stock-valuation";
import { GET as exportReport } from "@/app/(protected)/rapports/export/[type]/route";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * The Store Manager access policy — docs/adr/0048-store-manager-access-policy.md.
 * MANAGER + « Magasin » scope + one store's channel & location (invitation,
 * ADR 0047) + STORE_MANAGER_DENIES. No new role.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const fd = (fields: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => f.append(k, x));
    else f.set(k, v);
  }
  return f;
};
const ONLINE: Permission[] = (Object.keys(PERMISSION_CHANNEL_DOMAIN) as Permission[]).filter((p) => PERMISSION_CHANNEL_DOMAIN[p] === "ONLINE");

async function seedTwoStores() {
  const mk = async (tag: string) => {
    const wh = await prisma.warehouse.create({ data: { name: `Magasin ${tag}`, type: "MAGASIN" } });
    const ch = await prisma.salesChannel.create({ data: { name: `Boutique ${tag}`, kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: ch.id, warehouseId: wh.id } });
    return { wh, ch };
  };
  const a = await mk("A");
  const b = await mk("B");
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BSK-48", price: 250, status: "ACTIF", cost: 111 } });
  for (const s of [a, b]) {
    await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: s.ch.id } });
    await prisma.inventoryItem.create({ data: { warehouseId: s.wh.id, productId: product.id, quantityOnHand: 10 } });
  }
  const supplier = await prisma.supplier.create({ data: { name: "Fournisseur Atlas" } });
  return { a, b, product, supplier };
}

/** Invite → accept → admin applies the policy's DENYs → logged in as the store manager. */
async function storeManagerOf(store: { ch: { id: string }; wh: { id: string } }) {
  const admin = await loginAsTestUser({ role: "ADMIN" });
  const inv = await inviteUserAction(
    fd({ name: "Responsable A", email: "resp-a@test.local", role: "MANAGER", channelScope: "OFFLINE", offlineChannelIds: [store.ch.id], warehouseIds: [store.wh.id] })
  );
  if (!inv.ok) throw new Error(inv.error);
  mockCookieStore.clear();
  const accept = fd({ token: inv.data.inviteUrl.replace("/invitations/", ""), password: "correct-horse-battery-staple" });
  await expect(acceptInvitationAction(undefined, accept)).rejects.toThrow(RedirectSignal);
  const manager = await prismaBase.user.findFirstOrThrow({ where: { email: "resp-a@test.local" } });

  mockCookieStore.clear();
  await createSession(admin.id);
  const r = await setUserPermissionOverridesAction({ userId: manager.id, grants: [], denies: [...STORE_MANAGER_DENIES] });
  if (!r.ok) throw new Error(r.error);

  mockCookieStore.clear();
  await createSession(manager.id);
  return (await getCurrentUser())!;
}

const sale = (channelId: string, warehouseId: string, productId: string) => ({
  salesChannelId: channelId,
  warehouseId,
  idempotencyKey: randomUUID(),
  lines: [{ productId, quantity: 1 }],
  payments: [{ method: "ESPECES" as const, amount: 250 }],
});

describe("Store Manager — effective access (1, 2)", () => {
  it("exactly the documented permission set: no Online permission, store sales kept, every DENY applied", async () => {
    const { a } = await seedTwoStores();
    const me = await storeManagerOf(a);
    expect(me.role).toBe("MANAGER");
    expect([...me.permissions].sort()).toEqual([...STORE_MANAGER_PERMISSIONS].sort());
    for (const p of ONLINE) expect(me.permissions.has(p), p).toBe(false);
    for (const p of STORE_MANAGER_DENIES) expect(me.permissions.has(p), p).toBe(false);
    expect(me.channels.online).toBe(false);
    expect(me.channels.offlineIds).toEqual([a.ch.id]);
    // the template only DENIES what MANAGER actually holds (no dead override)
    for (const p of STORE_MANAGER_DENIES) expect(ROLE_PERMISSIONS.MANAGER.includes(p), p).toBe(true);
    for (const p of ["channels.manage", "finance.manage", "users.manage"] as const) expect(ROLE_PERMISSIONS.MANAGER.includes(p), p).toBe(false);
  });
});

describe("Store Manager — denied capabilities stay denied server-side (3-9)", () => {
  it("3. cannot pay suppliers", async () => {
    const { a, supplier } = await seedTwoStores();
    await storeManagerOf(a);
    await expect(recordSupplierPaymentAction({ supplierId: supplier.id, amount: 10 })).rejects.toThrow(/non autorisé/i);
    expect(await prisma.supplierPayment.count()).toBe(0);
  });

  it("4. no finance: finance.view refused, product cost invisible, stock report and its CSV carry no cost", async () => {
    const { a } = await seedTwoStores();
    const me = await storeManagerOf(a);
    await expect(requirePermissionForAction("finance.view")).rejects.toThrow(/non autorisé/i);
    expect(productCostVisibility(me).cost).toBe(false);

    const report = await getStockValuationReport({ warehouseIds: [a.wh.id], includeCost: false });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ unitCost: null, valueAtCost: null, valueAtRetail: 2500 });
    expect(report.totals).toMatchObject({ valueAtCost: null, potentialMargin: null, dormantValueAtCost: null, linesMissingCost: 0 });

    const csv = await (await exportReport(new Request("http://t/rapports/export/stock"), { params: Promise.resolve({ type: "stock" }) })).text();
    expect(csv).toContain("Basket");
    expect(csv).not.toMatch(/coût/i);
    expect(csv).not.toContain("111");
    expect(csv).not.toContain("1110");
  });

  it("5. cannot create or edit products", async () => {
    const { a, product } = await seedTwoStores();
    await storeManagerOf(a);
    await expect(createProductAction(fd({ name: "Nouveau", sku: "N-1", price: "10" }))).rejects.toThrow(/non autorisé/i);
    await expect(updateProductAction(fd({ id: product.id, name: "Basket", sku: "BSK-48", price: "1" }))).rejects.toThrow(/non autorisé/i);
    expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).price)).toBe(250);
  });

  it("6. cannot manage warehouses", async () => {
    const { a } = await seedTwoStores();
    await storeManagerOf(a);
    await expect(createWarehouseAction(fd({ name: "Nouveau dépôt" }))).rejects.toThrow(/non autorisé/i);
  });

  it("7. no audit journal, 8. no AI", async () => {
    const { a } = await seedTwoStores();
    await storeManagerOf(a);
    await expect(requirePermissionForAction("audit.view")).rejects.toThrow(/non autorisé/i);
    await expect(runAiToolAction("low-stock")).rejects.toThrow(/non autorisé/i);
  });

  it("9. cannot view, create or edit customers", async () => {
    const { a } = await seedTwoStores();
    const customer = await prisma.customer.create({ data: { fullName: "Client Web" } });
    await storeManagerOf(a);
    await expect(requirePermissionForAction("customers.view")).rejects.toThrow(/non autorisé/i);
    await expect(createCustomerAction(fd({ fullName: "Nouveau Client" }))).rejects.toThrow(/non autorisé/i);
    await expect(updateCustomerAction(fd({ id: customer.id, fullName: "Changé" }))).rejects.toThrow(/non autorisé/i);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).fullName).toBe("Client Web");
  });
});

describe("Store Manager — store operations in Store A, never Store B (10, 11)", () => {
  it("sells, returns, adjusts, counts and receives in Store A; every Store B mutation is refused", async () => {
    const { a, b, product, supplier } = await seedTwoStores();
    await storeManagerOf(a);

    // 10 — Store A operations
    const s = await createSaleAction(sale(a.ch.id, a.wh.id, product.id));
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId: s.data.id } });
    expect((await createSaleReturnAction({ saleId: s.data.id, idempotencyKey: randomUUID(), lines: [{ saleLineId: line.id, quantitySellable: 1, quantityDamaged: 0 }] })).ok).toBe(true);
    expect((await adjustInventoryAction(fd({ productId: product.id, warehouseId: a.wh.id, type: "AJUSTEMENT_POSITIF", quantity: "2", reason: "Recomptage" }))).ok).toBe(true);
    expect((await createStocktakeSessionAction({ warehouseId: a.wh.id })).ok).toBe(true);
    expect((await createReceptionAction({ supplierId: supplier.id, warehouseId: a.wh.id, lines: [{ productId: product.id, quantity: 3, unitCost: 100 }] })).ok).toBe(true);
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: a.wh.id } })).quantityOnHand).toBe(12);

    // 11 — Store B: channel, location, and Store A's channel on Store B's location
    await expect(createSaleAction(sale(b.ch.id, b.wh.id, product.id))).rejects.toThrow(/non autorisé/i);
    const crossed = await createSaleAction(sale(a.ch.id, b.wh.id, product.id)).catch(() => ({ ok: false as const }));
    expect(crossed.ok).toBe(false);
    await expect(adjustInventoryAction(fd({ productId: product.id, warehouseId: b.wh.id, type: "AJUSTEMENT_POSITIF", quantity: "2", reason: "Recomptage B" }))).rejects.toThrow(/non autorisé/i);
    await expect(createStocktakeSessionAction({ warehouseId: b.wh.id })).rejects.toThrow(/non autorisé/i);
    await expect(createReceptionAction({ supplierId: supplier.id, warehouseId: b.wh.id, lines: [{ productId: product.id, quantity: 1, unitCost: 1 }] })).rejects.toThrow(/non autorisé/i);
    await expect(
      createStockTransferAction({ sourceWarehouseId: a.wh.id, destinationWarehouseId: b.wh.id, lines: [{ productId: product.id, quantitySent: 1 }] })
    ).rejects.toThrow(/non autorisé/i);
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: b.wh.id } })).quantityOnHand).toBe(10);
  });
});

describe("unchanged neighbours (12-14)", () => {
  it("12. STORE_SELLER role permissions are exactly the four seller permissions", () => {
    expect([...ROLE_PERMISSIONS.STORE_SELLER].sort()).toEqual(["dashboard.view", "sales.create", "sales.return", "sales.view"]);
  });

  it("13. OWNER/ADMIN: every permission, and the Store Manager DENYs are inert on them", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      const r = computeEffectiveAccess({
        role,
        overrides: STORE_MANAGER_DENIES.map((permission) => ({ permission, effect: "DENY" as const })),
        assignedChannels: [],
        businessMode: "ONLINE_AND_OFFLINE",
      });
      expect(r.permissions.size, role).toBe(PERMISSIONS.length);
      expect(r.channels.global).toBe(true);
    }
  });

  it("14. an Online manager (no overrides) keeps the full MANAGER Online set, cost and finance included", async () => {
    await seedTwoStores();
    const m = await loginAsTestUser({ role: "MANAGER" });
    const me = (await getCurrentUser())!;
    expect(me.id).toBe(m.id);
    for (const p of ONLINE.filter((x) => ROLE_PERMISSIONS.MANAGER.includes(x))) expect(me.permissions.has(p), p).toBe(true);
    for (const p of STORE_MANAGER_DENIES) expect(me.permissions.has(p), p).toBe(true);
    expect(productCostVisibility(me).cost).toBe(true);
    // with finance.view, the stock report still carries cost (historical behaviour)
    const r = await getStockValuationReport({});
    expect(r.rows.every((row) => row.unitCost === 111)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADR 0048 final decisions — purchase prices hidden, price override kept
// ---------------------------------------------------------------------------

/** A validated Store-A reception at 100/unit, received by an ADMIN (the finance-authorised baseline). */
async function seedPurchaseHistory(store: { wh: { id: string } }, productId: string, supplierId: string) {
  const admin = await loginAsTestUser({ role: "ADMIN" });
  const r = await createReceptionAction({ supplierId, warehouseId: store.wh.id, lines: [{ productId, quantity: 4, unitCost: 100 }] });
  if (!r.ok) throw new Error(r.error);
  expect((await validateReceptionAction({ id: r.data.id })).ok).toBe(true);
  mockCookieStore.clear();
  return admin;
}

describe("Decision 2 — sales.override_price (1-5)", () => {
  it("1-4. the store manager holds sales.view/create/return/override_price and can sell below the catalogue price", async () => {
    const { a, product } = await seedTwoStores();
    const me = await storeManagerOf(a);
    for (const p of ["sales.view", "sales.create", "sales.return", "sales.override_price"] as const) expect(me.permissions.has(p), p).toBe(true);
    const r = await createSaleAction({
      ...sale(a.ch.id, a.wh.id, product.id),
      lines: [{ productId: product.id, quantity: 1, unitPrice: 200, discount: 10 }],
      payments: [{ method: "ESPECES" as const, amount: 190 }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId: r.data.id } });
    expect(Number(line.unitPrice)).toBe(200);
  });

  it("5. STORE_SELLER does not gain it — a changed price or discount is refused server-side", async () => {
    const { a, product } = await seedTwoStores();
    expect(ROLE_PERMISSIONS.STORE_SELLER.includes("sales.override_price")).toBe(false);
    const seller = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
    await grantChannelAccess(seller.id, a.ch.id);
    await grantLocationAccess(seller.id, a.wh.id);
    const me = (await getCurrentUser())!;
    expect(me.permissions.has("sales.override_price")).toBe(false);
    for (const line of [{ unitPrice: 200, discount: 0 }, { unitPrice: 250, discount: 10 }]) {
      const r = await createSaleAction({ ...sale(a.ch.id, a.wh.id, product.id), lines: [{ productId: product.id, quantity: 1, ...line }] });
      expect(r.ok).toBe(false);
    }
    expect(await prisma.sale.count()).toBe(0);
    // the catalogue price still sells
    expect((await createSaleAction(sale(a.ch.id, a.wh.id, product.id))).ok).toBe(true);
  });
});

describe("Decision 1 — operational purchasing without purchase prices (8, 15-20)", () => {
  it("8. cannot create or edit suppliers", async () => {
    const { a, supplier } = await seedTwoStores();
    await storeManagerOf(a);
    await expect(createSupplierAction({ name: "Nouveau Fournisseur" })).rejects.toThrow(/non autorisé/i);
    await expect(updateSupplierAction({ id: supplier.id, name: "Renommé", isActive: true })).rejects.toThrow(/non autorisé/i);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } })).name).toBe("Fournisseur Atlas");
  });

  it("15. receives goods in Store A end to end: typed price, draft edit keeps the stored price, validation adds stock", async () => {
    const { a, product, supplier } = await seedTwoStores();
    await storeManagerOf(a);
    const created = await createReceptionAction({ supplierId: supplier.id, warehouseId: a.wh.id, lines: [{ productId: product.id, quantity: 3, unitCost: 95 }] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // draft edit without seeing the price: null = « inchangé »
    const edit = await updateReceptionDraftAction({ id: created.data.id, supplierId: supplier.id, warehouseId: a.wh.id, lines: [{ productId: product.id, quantity: 5, unitCost: null }] });
    expect(edit.ok).toBe(true);
    const line = await prisma.receptionLine.findFirstOrThrow({ where: { receptionId: created.data.id } });
    expect({ quantity: line.quantity, unitCost: Number(line.unitCost) }).toEqual({ quantity: 5, unitCost: 95 });
    expect((await validateReceptionAction({ id: created.data.id })).ok).toBe(true);
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: a.wh.id } })).quantityOnHand).toBe(15);
  });

  it("a unit new to the draft needs a typed price (no silent 0)", async () => {
    const { a, product, supplier } = await seedTwoStores();
    const other = await prisma.product.create({ data: { name: "Chaussette", sku: "CH-1", price: 20, status: "ACTIF" } });
    await storeManagerOf(a);
    const created = await createReceptionAction({ supplierId: supplier.id, warehouseId: a.wh.id, lines: [{ productId: product.id, quantity: 1, unitCost: 90 }] });
    if (!created.ok) throw new Error(created.error);
    const r = await updateReceptionDraftAction({
      id: created.data.id,
      supplierId: supplier.id,
      warehouseId: a.wh.id,
      lines: [{ productId: product.id, quantity: 1, unitCost: null }, { productId: other.id, quantity: 2, unitCost: null }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/prix d'achat/i);
    expect(await prisma.receptionLine.count({ where: { receptionId: created.data.id } })).toBe(1);
  });

  it("11. a Store B draft can no longer be edited (or moved to Store A) by the Store A manager", async () => {
    const { a, b, product, supplier } = await seedTwoStores();
    await loginAsTestUser({ role: "ADMIN" });
    const bDraft = await createReceptionAction({ supplierId: supplier.id, warehouseId: b.wh.id, lines: [{ productId: product.id, quantity: 2, unitCost: 80 }] });
    if (!bDraft.ok) throw new Error(bDraft.error);
    mockCookieStore.clear();
    await storeManagerOf(a);
    await expect(
      updateReceptionDraftAction({ id: bDraft.data.id, supplierId: supplier.id, warehouseId: a.wh.id, lines: [{ productId: product.id, quantity: 9, unitCost: 1 }] })
    ).rejects.toThrow(/non autorisé/i);
    const still = await prisma.reception.findUniqueOrThrow({ where: { id: bDraft.data.id }, include: { lines: true } });
    expect(still.warehouseId).toBe(b.wh.id);
    expect(still.lines.map((l) => [l.quantity, Number(l.unitCost)])).toEqual([[2, 80]]);
  });

  it("16-19. purchase prices visible (purchases.view), product cost / supplier account / finance still hidden — docs/adr/0052", async () => {
    const { a, product, supplier } = await seedTwoStores();
    await seedPurchaseHistory(a, product.id, supplier.id);
    const me = await storeManagerOf(a);
    expect(me.permissions.has("finance.view")).toBe(false);
    expect(productCostVisibility(me)).toEqual({ cost: false, purchasePrices: true, supplierAccounts: false });
    // operational purchase prices: last-purchase hint, purchase history, reception movement unit cost
    expect((await getLatestPurchasePriceAction({ productId: product.id }))?.unitCost).toBe(100);
    expect((await getUnitPurchaseHistoryAction({ productId: product.id })).map((h) => h.unitCost)).toEqual([100]);
    const trace = await getUnitTraceability(me, { productId: product.id, variationId: null });
    const receptionMoves = trace!.movements.filter((m) => m.type === "RECEPTION");
    expect(receptionMoves.length).toBeGreaterThan(0);
    expect(receptionMoves.every((m) => m.unitCost === 100)).toBe(true);
    expect(trace!.movements.filter((m) => m.type !== "RECEPTION").every((m) => m.unitCost === null)).toBe(true);
    // the product cost (margin / valuation basis) is still never sent
    expect(JSON.stringify(trace)).not.toContain("111");
    const report = await getStockValuationReport({ warehouseIds: [a.wh.id], includeCost: productCostVisibility(me).cost });
    expect(report.rows[0]).toMatchObject({ unitCost: null, valueAtCost: null });
    // finance stays refused, payments stay refused
    await expect(requirePermissionForAction("finance.view")).rejects.toThrow(/non autorisé/i);
    await expect(recordSupplierPaymentAction({ supplierId: supplier.id, amount: 10 })).rejects.toThrow(/non autorisé/i);
    for (const type of ["rentabilite", "profitabilite", "tresorerie"]) {
      const res = await exportReport(new Request(`http://t/rapports/export/${type}`), { params: Promise.resolve({ type }) });
      expect(res.status, type).toBe(403);
    }
  });

  it("20. the owner / a finance-authorised user still sees every cost", async () => {
    const { a, product, supplier } = await seedTwoStores();
    await seedPurchaseHistory(a, product.id, supplier.id);
    await loginAsTestUser({ role: "OWNER" });
    const me = (await getCurrentUser())!;
    expect(productCostVisibility(me)).toEqual({ cost: true, purchasePrices: true, supplierAccounts: true });
    expect((await getLatestPurchasePriceAction({ productId: product.id }))?.unitCost).toBe(100);
    expect((await getUnitPurchaseHistoryAction({ productId: product.id })).map((h) => h.unitCost)).toEqual([100]);
    const trace = await getUnitTraceability(me, { productId: product.id, variationId: null });
    expect(trace!.movements.some((m) => m.unitCost !== null)).toBe(true);
    const report = await getStockValuationReport({ warehouseIds: [a.wh.id] });
    expect(report.rows[0]!.unitCost).toBe(111);
    const csv = await (await exportReport(new Request("http://t/rapports/export/stock"), { params: Promise.resolve({ type: "stock" }) })).text();
    expect(csv).toMatch(/Coût unitaire/);
  });

  it("23. tenant isolation unchanged: another tenant's draft reception is not found", async () => {
    const { a, product, supplier } = await seedTwoStores();
    await prismaBase.tenant.create({ data: { id: "tenant-b-0048", name: "B", slug: "tenant-b-0048" } });
    const supB = await prismaBase.supplier.create({ data: { name: "Fournisseur B", tenantId: "tenant-b-0048" } });
    const whB = await prismaBase.warehouse.create({ data: { name: "WB", tenantId: "tenant-b-0048" } });
    const recB = await prismaBase.reception.create({ data: { supplierId: supB.id, warehouseId: whB.id, tenantId: "tenant-b-0048" } });
    await storeManagerOf(a);
    const r = await updateReceptionDraftAction({ id: recB.id, supplierId: supplier.id, warehouseId: a.wh.id, lines: [{ productId: product.id, quantity: 1, unitCost: 1 }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/introuvable/i);
    expect(await prismaBase.receptionLine.count({ where: { receptionId: recB.id } })).toBe(0);
  });
});
