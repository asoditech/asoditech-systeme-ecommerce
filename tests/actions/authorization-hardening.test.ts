import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { landingPathFor } from "@/lib/auth/landing";
import { STORE_MANAGER_DENIES } from "@/lib/auth/store-manager-profile";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { quickSearchAction } from "@/actions/search";
import { adjustInventoryAction } from "@/actions/inventory";
import { inviteUserAction, acceptInvitationAction } from "@/actions/invitations";
import { listSales, getSaleDetail } from "@/lib/queries/sales";
import { getChannelReport } from "@/lib/queries/reports/channels";
import { getOfflineReturnsReport } from "@/lib/queries/reports/returns";
import { listReceptions, getReceptionDetail, getSupplierDetail, getSupplierPurchaseHistory, listSuppliers } from "@/lib/queries/purchases";
import { listStockTransfers, getStockTransferDetail } from "@/lib/queries/transfers";
import { listStocktakeSessions, getStocktakeSessionDetail } from "@/lib/queries/stocktakes";
import { getUnitTraceability } from "@/lib/queries/traceability";
import { listProducts, getProductDetail } from "@/lib/queries/products";
import { GET as exportReport } from "@/app/(protected)/rapports/export/[type]/route";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { createTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { createSession } from "@/lib/auth/session";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Authorization & access hardening — docs/adr/0050 (G4 read-side location
 * scoping, G7 shared store channel, G8 dashboard guard, G6d/G6e, Online
 * finance analytics). Server-side data, never UI visibility.
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

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const RANGE = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) };

async function as(user: { id: string }): Promise<CurrentUser> {
  mockCookieStore.clear();
  await createSession(user.id);
  return (await getCurrentUser())!;
}

/**
 * Three locations — store A, store B, warehouse C — and ONE store channel
 * deliberately shared by A and B (the G7 configuration), with a sale, a
 * reception, a stocktake and stock at each store, and transfers A→B and B→C.
 */
async function world() {
  const whA = await prisma.warehouse.create({ data: { name: "Magasin A", type: "MAGASIN" } });
  const whB = await prisma.warehouse.create({ data: { name: "Magasin B", type: "MAGASIN" } });
  const whC = await prisma.warehouse.create({ data: { name: "Dépôt C", type: "ENTREPOT" } });
  const shared = await prisma.salesChannel.create({ data: { name: "Boutiques", kind: "OFFLINE" } });
  for (const wh of [whA, whB]) await prisma.salesChannelLocation.create({ data: { salesChannelId: shared.id, warehouseId: wh.id } });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "AUTH-1", price: 200, cost: 80, status: "ACTIF" } });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: shared.id } });
  const itemA = await prisma.inventoryItem.create({ data: { warehouseId: whA.id, productId: product.id, quantityOnHand: 10 } });
  const itemB = await prisma.inventoryItem.create({ data: { warehouseId: whB.id, productId: product.id, quantityOnHand: 20 } });
  await prisma.inventoryItem.create({ data: { warehouseId: whC.id, productId: product.id, quantityOnHand: 30 } });
  const supplier = await prisma.supplier.create({ data: { name: "Fournisseur Z" } });

  const admin = await createTestUser({ role: "ADMIN" });
  await as(admin);
  const sale = async (wh: { id: string }) => {
    const r = await createSaleAction({ salesChannelId: shared.id, warehouseId: wh.id, idempotencyKey: randomUUID(), lines: [{ productId: product.id, quantity: 1 }], payments: [{ method: "ESPECES", amount: 200 }] });
    if (!r.ok) throw new Error(r.error);
    return r.data.id;
  };
  const saleA = await sale(whA);
  const saleB = await sale(whB);
  const reception = (wh: { id: string }, n: number) =>
    prisma.reception.create({
      data: { receptionNumber: n, supplierId: supplier.id, warehouseId: wh.id, status: "VALIDEE", totalCost: 80, lines: { create: [{ productId: product.id, nameSnapshot: "Basket", skuSnapshot: "AUTH-1", quantity: 1, unitCost: 80 }] } },
    });
  const recA = await reception(whA, 9001);
  const recB = await reception(whB, 9002);
  const transfer = (from: { id: string }, to: { id: string }, n: number) =>
    prisma.stockTransfer.create({ data: { transferNumber: n, sourceWarehouseId: from.id, destinationWarehouseId: to.id, lines: { create: [{ productId: product.id, quantitySent: 1 }] } } });
  const tAB = await transfer(whA, whB, 9001);
  const tBC = await transfer(whB, whC, 9002);
  const stA = await prisma.stocktakeSession.create({ data: { sessionNumber: 9001, warehouseId: whA.id } });
  const stB = await prisma.stocktakeSession.create({ data: { sessionNumber: 9002, warehouseId: whB.id } });
  mockCookieStore.clear();
  return { whA, whB, whC, shared, product, itemA, itemB, supplier, admin, saleA, saleB, recA, recB, tAB, tBC, stA, stB };
}

async function scopedUser(w: Awaited<ReturnType<typeof world>>, role: "STORE_SELLER" | "MANAGER", locations: { id: string }[], opts: { storeManager?: boolean } = {}) {
  const u = await createTestUser({ role, channels: "none" });
  await grantChannelAccess(u.id, w.shared.id);
  if (locations.length) await grantLocationAccess(u.id, locations.map((l) => l.id));
  if (opts.storeManager) {
    for (const p of STORE_MANAGER_DENIES) await prisma.userPermissionOverride.create({ data: { userId: u.id, permission: p, effect: "DENY" } });
  }
  return u;
}

/** Everything location-sensitive a viewer can read, as plain ids. */
async function readable(w: Awaited<ReturnType<typeof world>>, me: CurrentUser) {
  const products = await listProducts({}, me);
  const detail = await getProductDetail(w.product.id, me);
  const trace = await getUnitTraceability(me, { productId: w.product.id, variationId: null });
  return {
    sales: (await listSales(me)).sales.map((s) => s.id).sort(),
    saleBDetail: (await getSaleDetail(me, w.saleB)) !== null,
    offlineGross: (await getChannelReport(me, RANGE, { kind: "offline" })).offline?.grossSales ?? null,
    receptions: (await listReceptions({}, me)).receptions.map((r) => r.id).sort(),
    recBDetail: (await getReceptionDetail(w.recB.id, me)) !== null,
    supplierReceptions: (await getSupplierDetail(w.supplier.id, me))!.receptions.map((r) => r.id).sort(),
    purchaseHistory: (await getSupplierPurchaseHistory(w.supplier.id, 30, me)).map((l) => l.receptionId).sort(),
    supplierActivity: (await listSuppliers({}, me)).suppliers[0]?.receptionCount ?? 0,
    transfers: (await listStockTransfers({}, me)).transfers.map((t) => t.id).sort(),
    tBCDetail: (await getStockTransferDetail(w.tBC.id, me)) !== null,
    stocktakes: (await listStocktakeSessions({}, me)).sessions.map((s) => s.id).sort(),
    stBDetail: (await getStocktakeSessionDetail(w.stB.id, me)) !== null,
    traceLocations: (trace?.stock ?? []).map((s) => s.warehouseName).sort(),
    traceMovementLocations: [...new Set((trace?.movements ?? []).map((m) => m.location))].sort(),
    productStock: products.products[0]?.inventoryItems.reduce((n, i) => n + i.quantityOnHand, 0) ?? 0,
    detailStockLocations: (detail?.inventoryItems ?? []).map((i) => i.warehouse.name).sort(),
  };
}

// ---------------------------------------------------------------------------
// G4 + G7 — read-side location scoping, shared store channel
// ---------------------------------------------------------------------------

describe("G4/G7 — location-sensitive reads follow the viewer's own locations", () => {
  it("OWNER/ADMIN: everything (global)", async () => {
    const w = await world();
    const r = await readable(w, await as(w.admin));
    expect(r.sales).toEqual([w.saleA, w.saleB].sort());
    expect(r.receptions).toHaveLength(2);
    expect(r.transfers).toHaveLength(2);
    expect(r.stocktakes).toHaveLength(2);
    expect(r.traceLocations).toEqual(["Dépôt C", "Magasin A", "Magasin B"]);
    expect(r.productStock).toBe(58); // 10 + 20 + 30 − 2 sold
    expect(r.offlineGross).toBe(400);
  });

  for (const kind of ["STORE_SELLER", "Store Manager"] as const) {
    it(`${kind} of store A on a channel SHARED with store B: never sees store B (G7)`, async () => {
      const w = await world();
      const u = await scopedUser(w, kind === "STORE_SELLER" ? "STORE_SELLER" : "MANAGER", [w.whA], { storeManager: kind === "Store Manager" });
      const me = await as(u);
      const r = await readable(w, me);
      expect(r.sales).toEqual([w.saleA]);
      expect(r.saleBDetail).toBe(false);
      expect(r.offlineGross).toBe(200);
      // search never surfaces store B's sale either
      const saleB = await prisma.sale.findUniqueOrThrow({ where: { id: w.saleB } });
      const hits = (await quickSearchAction(String(saleB.saleNumber))).filter((h) => h.type === "sale").map((h) => h.id);
      expect(hits).not.toContain(w.saleB);
      if (kind === "Store Manager") {
        expect(r.receptions).toEqual([w.recA.id]);
        expect(r.recBDetail).toBe(false);
        expect(r.supplierReceptions).toEqual([w.recA.id]);
        expect(r.purchaseHistory).toEqual([w.recA.id]);
        expect(r.supplierActivity).toBe(1);
        expect(r.transfers).toEqual([w.tAB.id]); // touches A
        expect(r.tBCDetail).toBe(false);
        expect(r.stocktakes).toEqual([w.stA.id]);
        expect(r.stBDetail).toBe(false);
        expect(r.traceLocations).toEqual(["Magasin A"]);
        expect(r.traceMovementLocations).toEqual(["Magasin A"]);
        expect(r.productStock).toBe(9);
        expect(r.detailStockLocations).toEqual(["Magasin A"]);
      }
    });
  }

  it("multiple locations (A + B): both stores, never warehouse C", async () => {
    const w = await world();
    const me = await as(await scopedUser(w, "MANAGER", [w.whA, w.whB]));
    const r = await readable(w, me);
    expect(r.sales).toEqual([w.saleA, w.saleB].sort());
    expect(r.receptions).toEqual([w.recA.id, w.recB.id].sort());
    expect(r.transfers).toEqual([w.tAB.id, w.tBC.id].sort()); // B→C touches B
    expect(r.stocktakes).toEqual([w.stA.id, w.stB.id].sort());
    expect(r.traceLocations).toEqual(["Magasin A", "Magasin B"]);
    expect(r.productStock).toBe(28);
  });

  it("the offline returns report follows the same scope: a store-B return is invisible to store A", async () => {
    const w = await world();
    await as(w.admin);
    const lineB = await prisma.saleLine.findFirstOrThrow({ where: { saleId: w.saleB } });
    const ret = await createSaleReturnAction({ saleId: w.saleB, idempotencyKey: randomUUID(), lines: [{ saleLineId: lineB.id, quantitySellable: 1, quantityDamaged: 0 }] });
    expect(ret.ok).toBe(true);
    const adminReport = await getOfflineReturnsReport(RANGE, await as(w.admin));
    const storeA = await getOfflineReturnsReport(RANGE, await as(await scopedUser(w, "STORE_SELLER", [w.whA])));
    expect(JSON.stringify(adminReport)).toContain(w.saleB);
    expect(JSON.stringify(storeA)).not.toContain(w.saleB);
  });
});

// ---------------------------------------------------------------------------
// G6e — no explicit scope = no access, never "everything"
// ---------------------------------------------------------------------------

describe("G6e — a user with NO channel and NO location rows", () => {
  it("holds no channel-bound permission, reads nothing location-sensitive, mutates nothing", async () => {
    const w = await world();
    const u = await createTestUser({ role: "MANAGER", channels: "none" });
    const me = await as(u);
    expect(me.channels).toMatchObject({ online: false, offline: false });
    expect(me.locations).toEqual({ global: false, ids: [] });
    for (const p of ["orders.view", "orders.confirm", "sales.view", "sales.create", "commissions.manage"] as const) expect(me.permissions.has(p), p).toBe(false);
    const r = await readable(w, me);
    expect(r).toMatchObject({ sales: [], receptions: [], transfers: [], stocktakes: [], traceLocations: [], productStock: 0, supplierReceptions: [], purchaseHistory: [] });
    await expect(requirePermissionForAction("sales.view")).rejects.toThrow(/non autorisé/i);
    await expect(adjustInventoryAction(fd({ productId: w.product.id, warehouseId: w.whA.id, type: "AJUSTEMENT_POSITIF", quantity: "1", reason: "Recomptage" }))).rejects.toThrow(/non autorisé/i);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: w.itemA.id } })).quantityOnHand).toBe(9);
  });

  it("ONLINE_ONLY tenant: channels never apply (everyone Online), locations still do", async () => {
    await setTestBusinessMode("ONLINE_ONLY");
    const wh = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
    const supplier = await prisma.supplier.create({ data: { name: "F" } });
    await prisma.reception.create({ data: { receptionNumber: 1, supplierId: supplier.id, warehouseId: wh.id } });
    const unscoped = await as(await createTestUser({ role: "MANAGER", channels: "none" }));
    expect(unscoped.channels.online).toBe(true);
    expect(unscoped.permissions.has("orders.view")).toBe(true);
    expect(unscoped.permissions.has("sales.view")).toBe(false); // no Offline in this mode
    expect((await listReceptions({}, unscoped)).receptions).toEqual([]);
    const assigned = await createTestUser({ role: "MANAGER", channels: "none" });
    await grantLocationAccess(assigned.id, wh.id);
    expect((await listReceptions({}, await as(assigned))).receptions).toHaveLength(1);
  });

  it("another tenant's user reads none of this tenant's data", async () => {
    const w = await world();
    await prismaBase.tenant.create({ data: { id: "tenant-z-0050", name: "Z", slug: "tenant-z-0050" } });
    const other = await createTestUser({ role: "ADMIN", tenantId: "tenant-z-0050" });
    const me = await as(other);
    const r = await readable(w, me).catch(() => null);
    // supplier of tenant A is not found for tenant Z — the helper itself fails on it
    expect(r).toBeNull();
    expect((await listSales(me)).sales).toEqual([]);
    expect((await listReceptions({}, me)).receptions).toEqual([]);
    expect(await getSaleDetail(me, w.saleA)).toBeNull();
    expect(await getReceptionDetail(w.recA.id, me)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// G8 — dashboard.view is a real page guard
// ---------------------------------------------------------------------------

describe("G8 — dashboard.view", () => {
  it("the dashboard page forwards a user WITHOUT dashboard.view to the first page they may open", async () => {
    const w = await world();
    const { default: Dashboard } = await import("@/app/(protected)/tableau-de-bord/page");
    // a STORE_SELLER whose dashboard.view was denied → the sales list
    const seller = await scopedUser(w, "STORE_SELLER", [w.whA]);
    await prisma.userPermissionOverride.create({ data: { userId: seller.id, permission: "dashboard.view", effect: "DENY" } });
    const me = await as(seller);
    expect(landingPathFor(me)).toBe("/ventes");
    const err = await Dashboard({ searchParams: Promise.resolve({}) }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectSignal);
    expect((err as Error).message).toContain("/ventes");
  });

  it("landing fallbacks: dashboard first, else the first permitted page, else /acces-refuse", async () => {
    const w = await world();
    expect(landingPathFor(await as(w.admin))).toBe("/tableau-de-bord");
    const mgr = await createTestUser({ role: "MANAGER" });
    await prisma.userPermissionOverride.create({ data: { userId: mgr.id, permission: "dashboard.view", effect: "DENY" } });
    expect(landingPathFor(await as(mgr))).toBe("/commandes");
    const nobody = await createTestUser({ role: "SUPPORT", channels: "none" });
    for (const p of ["dashboard.view", "customers.view"]) await prisma.userPermissionOverride.create({ data: { userId: nobody.id, permission: p, effect: "DENY" } });
    expect(landingPathFor(await as(nobody))).toBe("/acces-refuse");
  });
});

// ---------------------------------------------------------------------------
// G6d — invitation cannot carry permission overrides
// ---------------------------------------------------------------------------

describe("G6d — invitation-time GRANT/DENY is deliberately not supported", () => {
  it("crafted grant/deny fields are ignored: the account starts with its role baseline and zero overrides", async () => {
    await createTestUser({ role: "OWNER" }).then(as);
    const f = fd({ name: "Agent", email: "agent-g6d@test.local", role: "CONFIRMATION", channelScope: "ONLINE" });
    for (const [k, v] of [["grants", "users.manage"], ["grants", "finance.manage"], ["denies", "orders.view"], ["overrides", "users.manage:GRANT"]]) f.append(k, v);
    const inv = await inviteUserAction(f);
    if (!inv.ok) throw new Error(inv.error);
    mockCookieStore.clear();
    const accept = fd({ token: inv.data.inviteUrl.replace("/invitations/", ""), password: "correct-horse-battery-staple" });
    await expect(acceptInvitationAction(undefined, accept)).rejects.toThrow(RedirectSignal);
    const u = await prismaBase.user.findFirstOrThrow({ where: { email: "agent-g6d@test.local" } });
    expect(u.role).toBe("CONFIRMATION");
    expect(await prismaBase.userPermissionOverride.count({ where: { userId: u.id } })).toBe(0);
    const me = (await getCurrentUser())!;
    expect(me.permissions.has("users.manage")).toBe(false);
    expect(me.permissions.has("finance.manage")).toBe(false);
    expect(me.permissions.has("orders.view")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Online analytics without finance.view
// ---------------------------------------------------------------------------

describe("Online finance analytics need finance.view", () => {
  const csv = async (type: string) => {
    const res = await exportReport(new Request(`http://t/rapports/export/${type}`), { params: Promise.resolve({ type }) });
    return { status: res.status, text: res.status === 200 ? await res.text() : "" };
  };

  it("analytics.view WITHOUT finance.view: profitability / margin / treasury CSVs refused, delivery CSV has no cost column", async () => {
    const mgr = await createTestUser({ role: "MANAGER" });
    await prisma.userPermissionOverride.create({ data: { userId: mgr.id, permission: "finance.view", effect: "DENY" } });
    const me = await as(mgr);
    expect(me.permissions.has("analytics.view")).toBe(true);
    for (const t of ["rentabilite", "profitabilite", "tresorerie"]) expect((await csv(t)).status, t).toBe(403);
    const delivery = await csv("livraison");
    expect(delivery.status).toBe(200);
    expect(delivery.text).not.toMatch(/Coût/i);
    expect(delivery.text).toMatch(/COD encaissé/);
    // non-financial analytics stay available
    expect((await csv("ventes")).status).toBe(200);
  });

  it("with finance.view: unchanged", async () => {
    await as(await createTestUser({ role: "MANAGER" }));
    for (const t of ["rentabilite", "profitabilite", "tresorerie"]) expect((await csv(t)).status, t).toBe(200);
    expect((await csv("livraison")).text).toMatch(/Coût livraisons/);
  });
});
