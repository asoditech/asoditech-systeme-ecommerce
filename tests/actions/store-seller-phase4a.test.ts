import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { PERMISSIONS, PERMISSION_CHANNEL_DOMAIN, ROLE_PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import { computeEffectiveAccess } from "@/lib/auth/effective-access";
import { productCostVisibility } from "@/lib/auth/cost-visibility";
import { requirePermission, requirePermissionForAction } from "@/lib/auth/guards";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { getCurrentUser } from "@/lib/auth/session";
import { createSaleAction, createSaleReturnAction, lookupForSaleAction } from "@/actions/sales";
import { createOrderAction } from "@/actions/orders";
import { adjustInventoryAction } from "@/actions/inventory";
import { createStockTransferAction } from "@/actions/transfers";
import { createStocktakeSessionAction } from "@/actions/stocktakes";
import { cancelReceptionAction, createReceptionAction } from "@/actions/purchases";
import { setUserPermissionOverridesAction } from "@/actions/users";
import { inviteUserAction, acceptInvitationAction } from "@/actions/invitations";
import { toSellerSafeUnit, type SellableUnit } from "@/lib/catalog/lookup";
import { getLowStockCount, getLowStockCountForViewer } from "@/lib/queries/inventory";
import { getDashboardData } from "@/lib/queries/dashboard";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Phase 4A — STORE_SELLER role + the four store-seller exposure fixes
 * (docs/adr/0042-store-seller-role.md). Everything here is asserted at the
 * SERVER boundary (guards, actions, queries), never through navigation.
 */

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const SELLER_PERMISSIONS: Permission[] = ["dashboard.view", "sales.view", "sales.create", "sales.return"];
const ONLINE_PERMISSIONS = (Object.keys(PERMISSION_CHANNEL_DOMAIN) as Permission[]).filter(
  (p) => PERMISSION_CHANNEL_DOMAIN[p] === "ONLINE"
);
const MUST_NOT_HAVE: Permission[] = [
  "sales.override_price",
  "products.view",
  "products.create",
  "products.edit",
  "inventory.view",
  "inventory.adjust",
  "inventory.transfer",
  "inventory.count",
  "purchases.view",
  "purchases.create",
  "purchases.pay",
  "suppliers.view",
  "suppliers.manage",
  "finance.view",
  "finance.manage",
  "analytics.view",
  "audit.view",
  "traceability.view",
  "customers.view",
  "customers.create",
  "customers.edit",
  "users.view",
  "users.manage",
  "settings.view",
  "settings.manage",
  "warehouses.manage",
  "channels.manage",
  "ai.use",
  ...ONLINE_PERMISSIONS,
];

const offline = [{ id: "store-1", kind: "OFFLINE" as const, isActive: true }];
const online = [{ id: "web", kind: "ONLINE" as const, isActive: true }];

/** A store channel + location + one product (cost 120) stocked and enabled there. */
async function seedStore() {
  const store = await prisma.warehouse.create({ data: { name: "Boutique Casa", type: "MAGASIN", isDefault: true } });
  const channel = await prisma.salesChannel.create({ data: { name: "Magasin Casablanca", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: channel.id, warehouseId: store.id } });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 300, status: "ACTIF", cost: 120 } });
  await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: store.id, productId: product.id, quantityOnHand: 10 } });
  return { store, channel, product, item };
}

/** A STORE_SELLER scoped to that store's channel only, optionally assigned its location. */
async function loginSeller(ctx: { channel: { id: string }; store: { id: string } }, opts: { location?: boolean } = {}) {
  const seller = await loginAsTestUser({ role: "STORE_SELLER", channels: "none" });
  await grantChannelAccess(seller.id, ctx.channel.id);
  if (opts.location ?? true) await grantLocationAccess(seller.id, ctx.store.id);
  return seller;
}

const sale = (
  ctx: { channel: { id: string }; store: { id: string } },
  lines: { productId: string; quantity: number; unitPrice?: number }[],
  amount: number
) => ({
  salesChannelId: ctx.channel.id,
  warehouseId: ctx.store.id,
  idempotencyKey: randomUUID(),
  lines,
  payments: [{ method: "ESPECES" as const, amount }],
});

// ---------------------------------------------------------------------------
// Part A / G — the role's exact permission set
// ---------------------------------------------------------------------------

describe("STORE_SELLER effective permissions", () => {
  it("the role matrix is EXACTLY the four counter permissions", () => {
    expect([...ROLE_PERMISSIONS.STORE_SELLER].sort()).toEqual([...SELLER_PERMISSIONS].sort());
  });

  it("with Offline-only scope: holds the four, and none of the forbidden ones", () => {
    const a = computeEffectiveAccess({ role: "STORE_SELLER", overrides: [], assignedChannels: offline, businessMode: "ONLINE_AND_OFFLINE" });
    for (const p of SELLER_PERMISSIONS) expect(a.permissions.has(p), p).toBe(true);
    for (const p of MUST_NOT_HAVE) expect(a.permissions.has(p), p).toBe(false);
    expect(a.permissions.size).toBe(SELLER_PERMISSIONS.length);
    expect(a.channels).toMatchObject({ global: false, online: false, offline: true });
  });

  it("gaining an Online channel later grants NO Online permission (none is in the role)", () => {
    const a = computeEffectiveAccess({
      role: "STORE_SELLER",
      overrides: [],
      assignedChannels: [...offline, ...online],
      businessMode: "ONLINE_AND_OFFLINE",
    });
    for (const p of ONLINE_PERMISSIONS) expect(a.permissions.has(p), p).toBe(false);
  });

  it("a GRANT still cannot bypass channel scope; a DENY still removes a role permission", () => {
    const a = computeEffectiveAccess({
      role: "STORE_SELLER",
      overrides: [
        { permission: "orders.view", effect: "GRANT" },
        { permission: "sales.return", effect: "DENY" },
      ],
      assignedChannels: offline,
      businessMode: "ONLINE_AND_OFFLINE",
    });
    expect(a.permissions.has("orders.view")).toBe(false);
    expect(a.permissions.has("sales.return")).toBe(false);
  });

  it("in an ONLINE_ONLY tenant the sales permissions are inert — only dashboard.view remains", () => {
    const a = computeEffectiveAccess({ role: "STORE_SELLER", overrides: [], assignedChannels: [], businessMode: "ONLINE_ONLY" });
    expect([...a.permissions]).toEqual(["dashboard.view"]);
  });

  it("every other role's matrix is unchanged by the new value (no permission removed or added)", () => {
    // Spot-check the roles the audit compared against: none gained a sales.* permission.
    expect(ROLE_PERMISSIONS.WAREHOUSE).not.toContain("sales.create");
    expect(ROLE_PERMISSIONS.DELIVERY).toEqual(["dashboard.view", "orders.view", "delivery.view", "delivery.manage"]);
    expect(ROLE_PERMISSIONS.MANAGER).toContain("sales.override_price");
    expect(ROLE_PERMISSIONS.OWNER).toEqual([...PERMISSIONS]);
  });
});

// ---------------------------------------------------------------------------
// Part G — STORE_SELLER + Offline scope, enforced server-side
// ---------------------------------------------------------------------------

describe("STORE_SELLER + Offline scope — server-side enforcement", () => {
  it("can run the store sale flow: lookup, sale, return", async () => {
    const ctx = await seedStore();
    await loginSeller(ctx);

    const hits = await lookupForSaleAction({ query: "BASKET-1", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ available: 10, tracked: true });
    expect(hits[0]!.unit).toMatchObject({ productId: ctx.product.id, price: 300, sku: "BASKET-1" });

    const r = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 2 }], 600));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the server still snapshots the cost from the database — nothing came from the browser
    const line = await prisma.saleLine.findFirstOrThrow({ where: { saleId: r.data.id } });
    expect(Number(line.costSnapshot)).toBe(120);

    const ret = await createSaleReturnAction({
      saleId: r.data.id,
      idempotencyKey: randomUUID(),
      lines: [{ saleLineId: line.id, quantitySellable: 1, quantityDamaged: 0 }],
      refundAmount: 300,
      refundMethod: "ESPECES",
    });
    expect(ret.ok).toBe(true);
  });

  it("cannot adjust the sale price (no sales.override_price)", async () => {
    const ctx = await seedStore();
    await loginSeller(ctx);
    const cheaper = await createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1, unitPrice: 100 }], 100));
    expect(cheaper.ok).toBe(false);
    expect(await prisma.sale.count()).toBe(0);
  });

  it("without an assigned location it cannot sell (safe default-deny), even with the right channel", async () => {
    const ctx = await seedStore();
    await loginSeller(ctx, { location: false });
    await expect(createSaleAction(sale(ctx, [{ productId: ctx.product.id, quantity: 1 }], 300))).rejects.toThrow(/non autorisé/i);
    await expect(
      lookupForSaleAction({ query: "BASKET-1", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id })
    ).rejects.toThrow(/non autorisé/i);
    expect(await prisma.sale.count()).toBe(0);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: ctx.item.id } })).quantityOnHand).toBe(10);
  });

  it("cannot reach the Online order flow — page guard, channel guard and the action itself", async () => {
    const ctx = await seedStore();
    await loginSeller(ctx);
    await expect(requirePermission("orders.view")).rejects.toThrow(RedirectSignal);
    const me = (await getCurrentUser())!;
    expect(() => requireChannelKind(me, "ONLINE")).toThrow(RedirectSignal);
    await expect(createOrderAction({} as never)).rejects.toThrow(/non autorisé/i);
  });

  it("cannot manage stock (adjust / transfer / count / receive)", async () => {
    const ctx = await seedStore();
    await loginSeller(ctx);
    await expect(adjustInventoryAction(new FormData())).rejects.toThrow(/non autorisé/i);
    await expect(createStockTransferAction({} as never)).rejects.toThrow(/non autorisé/i);
    await expect(createStocktakeSessionAction({} as never)).rejects.toThrow(/non autorisé/i);
    await expect(createReceptionAction({} as never)).rejects.toThrow(/non autorisé/i);
  });

  it("cannot access finance, products (cost), or user management", async () => {
    const ctx = await seedStore();
    await loginSeller(ctx);
    await expect(requirePermission("finance.view")).rejects.toThrow(RedirectSignal);
    await expect(requirePermission("products.view")).rejects.toThrow(RedirectSignal);
    await expect(requirePermission("users.view")).rejects.toThrow(RedirectSignal);
    await expect(requirePermissionForAction("users.manage")).rejects.toThrow(/non autorisé/i);
    await expect(setUserPermissionOverridesAction({ userId: "x", grants: [], denies: [] } as never)).rejects.toThrow(/non autorisé/i);
    expect(productCostVisibility((await getCurrentUser())!)).toEqual({ cost: false, purchasePrices: false, supplierAccounts: false });
  });
});

// ---------------------------------------------------------------------------
// Part B — invitation
// ---------------------------------------------------------------------------

describe("inviting a STORE_SELLER (existing Phase 2 flow, unchanged semantics)", () => {
  it("Offline scope → Offline channels only, zero locations, zero overrides, no Online permission", async () => {
    await prismaBase.salesChannel.create({ data: { name: "Boutique A", kind: "OFFLINE" } });
    await loginAsTestUser({ role: "ADMIN" });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ name: "Vendeur", email: "vendeur@test.local", role: "STORE_SELLER", channelScope: "OFFLINE" })) fd.set(k, v);
    const invite = await inviteUserAction(fd);
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    mockCookieStore.clear();
    const accept = new FormData();
    accept.set("token", invite.data.inviteUrl.replace("/invitations/", ""));
    accept.set("password", "correct-horse-battery-staple");
    await expect(acceptInvitationAction(undefined, accept)).rejects.toThrow(RedirectSignal);

    const created = await prismaBase.user.findFirstOrThrow({ where: { email: "vendeur@test.local" } });
    expect(created.role).toBe("STORE_SELLER");
    const channels = await prismaBase.userChannel.findMany({ where: { userId: created.id }, include: { salesChannel: true } });
    expect(channels.length).toBeGreaterThan(0);
    expect(channels.every((c) => c.salesChannel.kind === "OFFLINE")).toBe(true);
    expect(await prismaBase.userLocation.count({ where: { userId: created.id } })).toBe(0);
    expect(await prismaBase.userPermissionOverride.count({ where: { userId: created.id } })).toBe(0);

    // the accepted session is the new seller's: no Online permission, cannot sell before a location is assigned
    const me = await getCurrentUser();
    expect(me?.id).toBe(created.id);
    for (const p of ONLINE_PERMISSIONS) expect(me?.permissions.has(p), p).toBe(false);
    expect(me?.permissions.has("sales.create")).toBe(true);
  });

  it("the server-side invitation validation accepts the STORE_SELLER role", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ name: "Vendeur 2", email: "vendeur2@test.local", role: "STORE_SELLER" })) fd.set(k, v);
    expect((await inviteUserAction(fd)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G1 — no procurement cost in the seller-facing lookup payload
// ---------------------------------------------------------------------------

describe("G1 — sale lookup never exposes purchase cost", () => {
  it("toSellerSafeUnit drops cost and keeps every selling field", () => {
    const unit: SellableUnit = {
      productId: "p",
      variationId: "v",
      name: "T-Shirt",
      variantLabel: "Bleu / M",
      sku: "TSH-M",
      reference: "TSH",
      primaryBarcode: "123",
      categoryName: "Hauts",
      price: 150,
      cost: 42,
      status: "ACTIF",
      trackInventory: true,
      matchedBy: "barcode",
    };
    const safe = toSellerSafeUnit(unit);
    expect("cost" in safe).toBe(false);
    const { cost: _dropped, ...expected } = unit;
    void _dropped;
    expect(safe).toEqual(expected);
  });

  it("lookupForSaleAction's serialized payload contains no cost, for a seller AND for an admin", async () => {
    const ctx = await seedStore();
    await loginSeller(ctx);
    const asSeller = await lookupForSaleAction({ query: "BASKET", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(asSeller.length).toBeGreaterThan(0);
    const json = JSON.stringify(asSeller);
    expect(json).not.toMatch(/"cost"/);
    expect(json).not.toContain("120");

    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    const asAdmin = await lookupForSaleAction({ query: "BASKET", salesChannelId: ctx.channel.id, warehouseId: ctx.store.id });
    expect(asAdmin.length).toBeGreaterThan(0);
    for (const h of asAdmin) expect("cost" in h.unit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G3 — product detail purchase cost needs finance.view
// ---------------------------------------------------------------------------

describe("G3 — product cost visibility", () => {
  const viewer = (...perms: Permission[]) => ({ permissions: new Set<Permission>(perms) });

  it("products.view alone → nothing; purchases.view → purchase prices only (docs/adr/0052)", () => {
    expect(productCostVisibility(viewer("products.view"))).toEqual({ cost: false, purchasePrices: false, supplierAccounts: false });
    expect(productCostVisibility(viewer("products.view", "purchases.view"))).toEqual({ cost: false, purchasePrices: true, supplierAccounts: false });
  });

  it("finance.view → product cost; supplier accounts need finance.view AND purchases.view", () => {
    expect(productCostVisibility(viewer("products.view", "finance.view"))).toEqual({ cost: true, purchasePrices: false, supplierAccounts: false });
    expect(productCostVisibility(viewer("products.view", "finance.view", "purchases.view"))).toEqual({ cost: true, purchasePrices: true, supplierAccounts: true });
  });

  it("resolved sessions: WAREHOUSE (no finance.view) sees no cost; MANAGER and ADMIN do", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    expect(productCostVisibility((await getCurrentUser())!).cost).toBe(false);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" });
    expect(productCostVisibility((await getCurrentUser())!)).toEqual({ cost: true, purchasePrices: true, supplierAccounts: true });
    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect(productCostVisibility((await getCurrentUser())!)).toEqual({ cost: true, purchasePrices: true, supplierAccounts: true });
  });
});

// ---------------------------------------------------------------------------
// G2 — cancelling a reception requires the destination location
// ---------------------------------------------------------------------------

describe("G2 — cancelReceptionAction location check", () => {
  async function seedDraft() {
    const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
    const other = await prisma.warehouse.create({ data: { name: "Boutique Rabat", type: "MAGASIN" } });
    const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 300, status: "ACTIF" } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 5 } });
    const supplier = await prisma.supplier.create({ data: { name: "Fournisseur Casa" } });
    const reception = await prisma.reception.create({ data: { supplierId: supplier.id, warehouseId: warehouse.id } });
    return { warehouse, other, reception };
  }
  const statusOf = async (id: string) => (await prismaBase.reception.findUniqueOrThrow({ where: { id } })).status;

  it("assigned location → allowed", async () => {
    const { warehouse, reception } = await seedDraft();
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(u.id, warehouse.id);
    expect((await cancelReceptionAction({ id: reception.id })).ok).toBe(true);
    expect(await statusOf(reception.id)).toBe("ANNULEE");
  });

  it("unassigned location → denied, and the draft is untouched", async () => {
    const { other, reception } = await seedDraft();
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(u.id, other.id); // assigned somewhere — just not here
    await expect(cancelReceptionAction({ id: reception.id })).rejects.toThrow(/non autorisé/i);
    expect(await statusOf(reception.id)).toBe("BROUILLON");
  });

  it("OWNER and ADMIN → allowed with no assignment row (global semantics)", async () => {
    const a = await seedDraft();
    await loginAsTestUser({ role: "OWNER" });
    expect((await cancelReceptionAction({ id: a.reception.id })).ok).toBe(true);

    mockCookieStore.clear();
    const b = await prisma.reception.create({
      data: { supplierId: (await prisma.supplier.findFirstOrThrow()).id, warehouseId: a.warehouse.id },
    });
    await loginAsTestUser({ role: "ADMIN" });
    expect((await cancelReceptionAction({ id: b.id })).ok).toBe(true);
  });

  it("a reception of another tenant → not found, and never cancelled", async () => {
    const TENANT_B = "tenant-b-phase4a-receptions";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const wB = await prismaBase.warehouse.create({ data: { name: "Entrepôt B", isDefault: true, tenantId: TENANT_B } });
    const sB = await prismaBase.supplier.create({ data: { name: "Fournisseur B", tenantId: TENANT_B } });
    const rB = await prismaBase.reception.create({ data: { supplierId: sB.id, warehouseId: wB.id, tenantId: TENANT_B } });

    await loginAsTestUser({ role: "ADMIN" }); // tenant A — global in A, nothing in B
    const r = await cancelReceptionAction({ id: rB.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/introuvable/i);
    expect(await statusOf(rB.id)).toBe("BROUILLON");
  });

  it("the existing state machine is unchanged: a non-draft still cannot be cancelled", async () => {
    const { warehouse, reception } = await seedDraft();
    await prisma.reception.update({ where: { id: reception.id }, data: { status: "VALIDEE" } });
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(u.id, warehouse.id);
    const r = await cancelReceptionAction({ id: reception.id });
    expect(r.ok).toBe(false);
    expect(await statusOf(reception.id)).toBe("VALIDEE");
  });
});

// ---------------------------------------------------------------------------
// G5 — dashboard low-stock count respects the viewer's locations
// ---------------------------------------------------------------------------

describe("G5 — location-aware low-stock count", () => {
  /** A: 1 low item · B: 2 low items (+1 healthy) · C (inactive): 1 low item. Threshold 5. */
  async function seedLowStock() {
    const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 300, status: "ACTIF", lowStockThreshold: 5 } });
    const other = await prisma.product.create({ data: { name: "Sac", sku: "SAC-1", price: 100, status: "ACTIF", lowStockThreshold: 5 } });
    const a = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
    const b = await prisma.warehouse.create({ data: { name: "B" } });
    const c = await prisma.warehouse.create({ data: { name: "C", isActive: false } });
    await prisma.inventoryItem.create({ data: { warehouseId: a.id, productId: product.id, quantityOnHand: 1 } });
    await prisma.inventoryItem.create({ data: { warehouseId: b.id, productId: product.id, quantityOnHand: 2 } });
    await prisma.inventoryItem.create({ data: { warehouseId: b.id, productId: other.id, quantityOnHand: 0 } });
    await prisma.inventoryItem.create({ data: { warehouseId: a.id, productId: other.id, quantityOnHand: 50 } }); // healthy
    await prisma.inventoryItem.create({ data: { warehouseId: c.id, productId: other.id, quantityOnHand: 1 } });
    return { a, b, c };
  }

  it("one assigned location → only that location's low items", async () => {
    const { a } = await seedLowStock();
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(u.id, a.id);
    expect(await getLowStockCountForViewer((await getCurrentUser())!)).toBe(1);
  });

  it("multiple assigned locations → the sum of those locations", async () => {
    const { a, b } = await seedLowStock();
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(u.id, [a.id, b.id]);
    expect(await getLowStockCountForViewer((await getCurrentUser())!)).toBe(3);
  });

  it("zero locations → 0 (default-deny, never tenant-wide); an inactive assignment counts nothing", async () => {
    const { c } = await seedLowStock();
    await loginAsTestUser({ role: "WAREHOUSE" });
    expect(await getLowStockCountForViewer((await getCurrentUser())!)).toBe(0);

    mockCookieStore.clear();
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(u.id, c.id);
    expect(await getLowStockCountForViewer((await getCurrentUser())!)).toBe(0);
  });

  it("OWNER / ADMIN → tenant-wide, identical to the pre-existing count", async () => {
    await seedLowStock();
    await loginAsTestUser({ role: "OWNER" });
    const tenantWide = await getLowStockCount();
    expect(tenantWide).toBe(4);
    expect(await getLowStockCountForViewer((await getCurrentUser())!)).toBe(tenantWide);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "ADMIN" });
    expect(await getLowStockCountForViewer((await getCurrentUser())!)).toBe(4);
  });

  it("tenant isolation: another tenant's low stock is never counted", async () => {
    await seedLowStock();
    const TENANT_B = "tenant-b-phase4a-lowstock";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "Tenant B", slug: TENANT_B } });
    const wB = await prismaBase.warehouse.create({ data: { name: "Entrepôt B", isDefault: true, tenantId: TENANT_B } });
    const pB = await prismaBase.product.create({ data: { name: "B", sku: "B-1", price: 1, status: "ACTIF", lowStockThreshold: 5, tenantId: TENANT_B } });
    await prismaBase.inventoryItem.create({ data: { warehouseId: wB.id, productId: pB.id, quantityOnHand: 0, tenantId: TENANT_B } });

    await loginAsTestUser({ role: "ADMIN" });
    expect(await getLowStockCountForViewer((await getCurrentUser())!)).toBe(4);
    // a forged foreign warehouse id adds nothing either
    expect(await getLowStockCount({ warehouseIds: [wB.id] })).toBe(0);
  });

  it("the dashboard wires the viewer through: getDashboardData(…, { viewer }) is scoped", async () => {
    const { a } = await seedLowStock();
    const u = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(u.id, a.id);
    const viewer = (await getCurrentUser())!;
    expect((await getDashboardData("mois", undefined, { viewer })).lowStockCount).toBe(1);
    // without a viewer the legacy tenant-wide behaviour is unchanged
    expect((await getDashboardData("mois")).lowStockCount).toBe(4);
  });
});
