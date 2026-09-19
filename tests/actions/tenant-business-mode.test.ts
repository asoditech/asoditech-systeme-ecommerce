import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createTenantAction, setTenantBusinessModeAction, previewTenantBusinessModeChange } from "@/actions/tenants";
import { createSaleAction } from "@/actions/sales";
import { createReceptionAction, createSupplierAction, recordSupplierPaymentAction, validateReceptionAction } from "@/actions/purchases";
import { createSalesChannelAction } from "@/actions/channels";
import { addBarcodeAction, lookupSellableUnitsAction, setProductChannelsAction, updateProductReferenceAction } from "@/actions/catalog";
import { createProductAction, createCategoryAction, createProductVariationAction } from "@/actions/products";
import { setUserChannelsAction, setUserPermissionOverridesAction } from "@/actions/users";
import { quickSearchAction } from "@/actions/search";
import { requirePermission, requirePermissionForAction } from "@/lib/auth/guards";
import { requireCapability, requireCapabilityForAction } from "@/lib/auth/capabilities";
import { getCurrentUser, createSession } from "@/lib/auth/session";
import { notifyNewOrder } from "@/lib/notifications";
import { NAV_GROUPS, hasDomainAccess } from "@/components/layout/sidebar-nav";
import { GET as exportReport } from "@/app/(protected)/rapports/export/[type]/route";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { DEFAULT_TENANT_ID, resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, ensureDefaultOnlineChannelFor } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Tenant business mode / provisioning — docs/adr/0041. The default test tenant
 * is ONLINE_ONLY (resetDb), so this file also proves the previous system's
 * behaviour is preserved for it.
 */

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const NOT_ENABLED = /pas activée|non autorisé/i;

describe("the default: every tenant is ONLINE_ONLY (= the previous system)", () => {
  it("the bootstrap tenant and a tenant created without a mode are ONLINE_ONLY", async () => {
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).businessMode).toBe("ONLINE_ONLY");
    const t = await prismaBase.tenant.create({ data: { id: "no-mode", name: "N", slug: "no-mode" } });
    expect(t.businessMode).toBe("ONLINE_ONLY");
  });

  it("a user with NO channel rows keeps full Online access (channel machinery is ignored) — no lock-out", async () => {
    await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await expect(requirePermissionForAction("orders.view")).resolves.toBeDefined();
    await expect(requirePermissionForAction("orders.confirm")).resolves.toBeDefined();
    await expect(requirePermissionForAction("delivery.manage")).resolves.toBeDefined();
    const user = (await getCurrentUser())!;
    expect(user.channels).toMatchObject({ online: true, offline: false });
    expect(user.businessMode).toBe("ONLINE_ONLY");
    expect(user.capabilities.size).toBe(0);
  });

  it("notification recipients are NOT narrowed by missing channel rows in an ONLINE_ONLY tenant", async () => {
    const noRows = await createTestUser({ role: "MANAGER", channels: "none" });
    await notifyNewOrder({ id: "o1", orderNumber: 1, displayNumber: 1, total: "10", currency: "MAD", customerName: "C", source: "INTERNE" });
    expect((await prisma.notification.findMany()).map((n) => n.userId)).toContain(noRows.id);
  });

  it("the sidebar shows exactly the pre-existing navigation — no Ventes, Réceptions, Fournisseurs or Traçabilité, even for OWNER", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const user = (await getCurrentUser())!;
    const visible = NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => user.permissions.has(i.permission) && (!i.domain || hasDomainAccess(user.permissions, i.domain)))
      .map((i) => i.href);
    for (const gated of ["/ventes", "/receptions", "/fournisseurs", "/tracabilite"]) expect(visible).not.toContain(gated);
    for (const legacy of ["/tableau-de-bord", "/commandes", "/produits", "/stock", "/transferts", "/inventaires", "/entrepots", "/rapports", "/finance", "/utilisateurs", "/parametres"]) {
      expect(visible).toContain(legacy);
    }
  });
});

describe("ONLINE_ONLY: Offline capabilities are closed SERVER-SIDE (not just hidden)", () => {
  it("OWNER cannot sell, receive, pay suppliers, create suppliers or channels — nothing is created", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const ch = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    const wh = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });

    await expect(
      createSaleAction({ salesChannelId: ch.id, warehouseId: wh.id, idempotencyKey: randomUUID(), lines: [{ productId: "x", quantity: 1 }], payments: [] })
    ).rejects.toThrow(/non autorisé/i);
    await expect(createSupplierAction({ name: "Fournisseur" })).rejects.toThrow(/non autorisé/i);
    await expect(createReceptionAction({ supplierId: "x", warehouseId: wh.id, lines: [{ productId: "x", quantity: 1, unitCost: 1 }] })).rejects.toThrow(/non autorisé/i);
    await expect(validateReceptionAction({ id: "x" })).rejects.toThrow(/non autorisé/i);
    await expect(recordSupplierPaymentAction({ supplierId: "x", amount: 5 })).rejects.toThrow(/non autorisé/i);
    await expect(createSalesChannelAction({ name: "Autre", kind: "OFFLINE", warehouseIds: [] })).rejects.toThrow(/non autorisé/i);

    expect(await prisma.sale.count()).toBe(0);
    expect(await prisma.supplier.count()).toBe(0);
    expect(await prisma.reception.count()).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("the traceability page permission is not held by anyone, OWNER included (requirePermission redirects)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await expect(requirePermission("traceability.view")).rejects.toThrow(/acces-refuse/);
    await expect(requirePermission("sales.view")).rejects.toThrow(/acces-refuse/);
    await expect(requirePermission("purchases.view")).rejects.toThrow(/acces-refuse/);
    await expect(requirePermission("channels.manage")).rejects.toThrow(/acces-refuse/);
    await expect(requirePermission("orders.view")).resolves.toBeDefined(); // …while the legacy ones work
  });

  it("actions gated by a capability instead of a permission are refused (barcodes, reference, channel availability, code lookup, user channels)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const p = await prisma.product.create({ data: { name: "P", sku: "P-1", price: 10, status: "ACTIF" } });
    const u = await createTestUser({ role: "MANAGER" });

    await expect(addBarcodeAction({ productId: p.id, code: "123456789" })).rejects.toThrow(NOT_ENABLED);
    await expect(updateProductReferenceAction({ productId: p.id, reference: "REF" })).rejects.toThrow(NOT_ENABLED);
    await expect(setProductChannelsAction({ productId: p.id, salesChannelIds: [] })).rejects.toThrow(NOT_ENABLED);
    await expect(lookupSellableUnitsAction({ query: "P-1" })).rejects.toThrow(NOT_ENABLED);
    await expect(setUserChannelsAction({ userId: u.id, salesChannelIds: [] })).rejects.toThrow(NOT_ENABLED);

    expect(await prisma.barcode.count()).toBe(0);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).reference).toBeNull();
  });

  it("per-user overrides for an Offline permission are refused; overrides for Online permissions still work", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const u = await createTestUser({ role: "CONFIRMATION" });
    expect((await setUserPermissionOverridesAction({ userId: u.id, grants: ["sales.create"], denies: [] })).ok).toBe(false);
    expect((await setUserPermissionOverridesAction({ userId: u.id, grants: ["orders.cancel"], denies: [] })).ok).toBe(true);
  });

  it("the product form's identity inputs are IGNORED: same result as the pre-existing form", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const online = await ensureDefaultOnlineChannel();
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    const r = await createProductAction(
      fd({ name: "Basket", sku: "BASKET-1", price: "100", status: "ACTIF", reference: "MODELE", barcode: "6111111111111", channelsSubmitted: "1" })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fdWithChannel = new FormData();
    fdWithChannel.set("name", "Basket 2"); fdWithChannel.set("sku", "BASKET-2"); fdWithChannel.set("price", "100"); fdWithChannel.set("status", "ACTIF");
    fdWithChannel.set("channelsSubmitted", "1"); fdWithChannel.append("salesChannelIds", store.id);
    const r2 = await createProductAction(fdWithChannel);
    expect(r2.ok).toBe(true);

    const p1 = await prisma.product.findUniqueOrThrow({ where: { id: r.data.id }, include: { barcodes: true, salesChannels: true } });
    expect(p1.reference).toBeNull();
    expect(p1.barcodes).toHaveLength(0);
    expect(p1.salesChannels.map((c) => c.salesChannelId)).toEqual([online.id]); // legacy: sellable through the default online channel
    if (r2.ok) {
      const p2 = await prisma.productSalesChannel.findMany({ where: { productId: r2.data.id } });
      expect(p2.map((c) => c.salesChannelId)).toEqual([online.id]); // the store channel was NOT applied
    }
  });

  it("a variation's barcode input is ignored, and category creation keeps its historical contract (explicit slug required)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const parent = await prisma.product.create({ data: { name: "P", sku: "PAR", price: 10, status: "ACTIF" } });
    const v = await createProductVariationAction(fd({ productId: parent.id, sku: "PAR-1", barcode: "999888777", attributes: JSON.stringify({ Taille: "42" }) }));
    expect(v.ok).toBe(true);
    expect(await prisma.barcode.count()).toBe(0);

    expect((await createCategoryAction(fd({ name: "Chaussures Homme" }))).ok).toBe(false); // no derived slug
    expect((await createCategoryAction(fd({ name: "Chaussures Homme", slug: "chaussures-homme" }))).ok).toBe(true);
  });

  it("the Online/Offline/Total report and its CSV export are not available", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const res = await exportReport(new Request("http://x/rapports/export/canaux"), { params: Promise.resolve({ type: "canaux" }) });
    expect(res.status).toBe(403);
    // …while a legacy report still works
    expect((await exportReport(new Request("http://x/rapports/export/stock"), { params: Promise.resolve({ type: "stock" }) })).status).toBe(200);
  });

  it("global search has no supplier / sale results", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await prisma.supplier.create({ data: { name: "Fournisseur Findme" } });
    expect((await quickSearchAction("Findme")).some((r) => r.type === "supplier")).toBe(false);
  });

  it("capability guards: requireCapability redirects, requireCapabilityForAction throws", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const user = (await getCurrentUser())!;
    expect(() => requireCapability(user, "offlineSales")).toThrow(/acces-refuse/);
    expect(() => requireCapabilityForAction(user, "purchasing")).toThrow(/pas activée/i);
  });
});

describe("ONLINE_AND_OFFLINE unlocks the same surfaces", () => {
  beforeEach(async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
  });

  it("the gated permissions, capability actions, navigation and search all appear", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const user = (await getCurrentUser())!;
    expect(user.capabilities.size).toBe(5);
    for (const p of ["sales.view", "purchases.view", "suppliers.view", "channels.manage", "traceability.view"] as const) {
      await expect(requirePermission(p)).resolves.toBeDefined();
    }
    const visible = NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => user.permissions.has(i.permission) && (!i.domain || hasDomainAccess(user.permissions, i.domain)))
      .map((i) => i.href);
    for (const href of ["/ventes", "/receptions", "/fournisseurs", "/tracabilite"]) expect(visible).toContain(href);

    const p = await prisma.product.create({ data: { name: "P", sku: "P-1", price: 10, status: "ACTIF" } });
    expect((await addBarcodeAction({ productId: p.id, code: "123456789" })).ok).toBe(true);
    await prisma.supplier.create({ data: { name: "Fournisseur Findme" } });
    expect((await quickSearchAction("Findme")).some((r) => r.type === "supplier")).toBe(true);
    expect((await exportReport(new Request("http://x/rapports/export/canaux"), { params: Promise.resolve({ type: "canaux" }) })).status).toBe(200);
  });
});

describe("/platform — provisioning with a mode", () => {
  it("a platform admin creates a tenant with a chosen mode; omitted/blank means ONLINE_ONLY; an unknown mode is rejected", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    const base = { ownerName: "Owner", ownerEmail: "o@x.test" };

    const dual = await createTenantAction(fd({ name: "Dual Co", slug: "dual-co", businessMode: "ONLINE_AND_OFFLINE", ...base }));
    const dflt = await createTenantAction(fd({ name: "Default Co", slug: "default-co", ...base, ownerEmail: "d@x.test" }));
    const blank = await createTenantAction(fd({ name: "Blank Co", slug: "blank-co", businessMode: "", ...base, ownerEmail: "b@x.test" }));
    const bad = await createTenantAction(fd({ name: "Bad Co", slug: "bad-co", businessMode: "OFFLINE_ONLY", ...base, ownerEmail: "x@x.test" }));

    expect(dual.ok && dflt.ok && blank.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: "dual-co" } })).businessMode).toBe("ONLINE_AND_OFFLINE");
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: "default-co" } })).businessMode).toBe("ONLINE_ONLY");
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: "blank-co" } })).businessMode).toBe("ONLINE_ONLY");
    expect(await prismaBase.tenant.count({ where: { id: "bad-co" } })).toBe(0);
    // provisioning is unchanged for both modes: each has its baseline (warehouse + default online channel)
    for (const id of ["dual-co", "default-co"]) {
      expect(await prismaBase.warehouse.count({ where: { tenantId: id, isDefault: true } })).toBe(1);
      expect(await prismaBase.salesChannel.count({ where: { tenantId: id, isDefault: true } })).toBe(1);
    }
    const audit = await prismaBase.auditEvent.findFirstOrThrow({ where: { action: "tenant.created", entityId: "dual-co" } });
    expect((audit.newValue as { businessMode: string }).businessMode).toBe("ONLINE_AND_OFFLINE");
  });

  it("only a platform admin may change a mode — a tenant's own OWNER cannot", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: false });
    await expect(setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "ONLINE_AND_OFFLINE" }))).rejects.toThrow(/non autorisé/i);
    await expect(previewTenantBusinessModeChange(DEFAULT_TENANT_ID, "ONLINE_AND_OFFLINE")).rejects.toThrow(/non autorisé/i);
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).businessMode).toBe("ONLINE_ONLY");
  });

  it("upgrading unlocks the capabilities on the tenant's NEXT request, ensures its default channel, and is audited", async () => {
    const admin = await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    await expect(requirePermissionForAction("sales.view")).rejects.toThrow(/non autorisé/i);
    expect(await prisma.salesChannel.count()).toBe(0);

    const r = await setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "ONLINE_AND_OFFLINE" }));
    expect(r.ok).toBe(true);

    await expect(requirePermissionForAction("sales.view")).resolves.toBeDefined();
    expect(await prisma.salesChannel.count({ where: { isDefault: true } })).toBe(1);
    const audit = await prismaBase.auditEvent.findFirstOrThrow({ where: { action: "tenant.business_mode_changed" } });
    expect(audit).toMatchObject({ actorUserId: admin.id, entityId: DEFAULT_TENANT_ID });
    expect(audit.previousValue).toEqual({ businessMode: "ONLINE_ONLY" });
    expect(audit.newValue).toEqual({ businessMode: "ONLINE_AND_OFFLINE" });
  });

  it("changing to the mode a tenant already has, or an unknown tenant/mode, is refused", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    expect((await setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "ONLINE_ONLY" }))).ok).toBe(false);
    expect((await setTenantBusinessModeAction(fd({ tenantId: "nope", businessMode: "ONLINE_AND_OFFLINE" }))).ok).toBe(false);
    expect((await setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "OFFLINE_ONLY" }))).ok).toBe(false);
  });

  it("a DOWNGRADE with only configuration (store channel, barcodes, an empty supplier) succeeds and keeps every row, inert", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    const p = await prisma.product.create({ data: { name: "P", sku: "P-1", price: 10, status: "ACTIF" } });
    await prisma.barcode.create({ data: { code: "KEEP-CODE", productId: p.id, isPrimary: true } });
    await prisma.supplier.create({ data: { name: "Vide" } });

    const plan = await previewTenantBusinessModeChange(DEFAULT_TENANT_ID, "ONLINE_ONLY");
    expect(plan).toMatchObject({ allowed: true, from: "ONLINE_AND_OFFLINE", to: "ONLINE_ONLY" });
    expect((await setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "ONLINE_ONLY" }))).ok).toBe(true);

    // nothing deleted…
    expect(await prisma.salesChannel.count({ where: { id: store.id } })).toBe(1);
    expect(await prisma.barcode.count()).toBe(1);
    expect(await prisma.supplier.count()).toBe(1);
    // …but inert
    await expect(requirePermissionForAction("suppliers.view")).rejects.toThrow(/non autorisé/i);
    // and promoting again brings everything back
    await setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "ONLINE_AND_OFFLINE" }));
    await expect(requirePermissionForAction("suppliers.view")).resolves.toBeDefined();
  });

  it("a DOWNGRADE is REFUSED while the tenant owns sales, receptions or supplier payments — with the reason — and nothing changes", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const wh = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });
    const ch = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    const sup = await prisma.supplier.create({ data: { name: "S" } });

    // 1. a reception
    const rec = await prisma.reception.create({ data: { supplierId: sup.id, warehouseId: wh.id } });
    let plan = await previewTenantBusinessModeChange(DEFAULT_TENANT_ID, "ONLINE_ONLY");
    expect(plan?.allowed).toBe(false);
    expect(plan?.reason).toMatch(/réception/);
    expect((await setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "ONLINE_ONLY" }))).ok).toBe(false);
    await prisma.reception.delete({ where: { id: rec.id } });

    // 2. a supplier payment
    const pay = await prisma.supplierPayment.create({ data: { supplierId: sup.id, amount: 5 } });
    plan = await previewTenantBusinessModeChange(DEFAULT_TENANT_ID, "ONLINE_ONLY");
    expect(plan?.reason).toMatch(/paiement/);
    await prisma.supplierPayment.delete({ where: { id: pay.id } });

    // 3. a sale
    await prisma.sale.create({ data: { salesChannelId: ch.id, warehouseId: wh.id, idempotencyKey: "k-0000001", subtotal: 1, total: 1 } });
    plan = await previewTenantBusinessModeChange(DEFAULT_TENANT_ID, "ONLINE_ONLY");
    expect(plan).toMatchObject({ allowed: false });
    expect(plan?.reason).toMatch(/vente/);
    expect((await setTenantBusinessModeAction(fd({ tenantId: DEFAULT_TENANT_ID, businessMode: "ONLINE_ONLY" }))).ok).toBe(false);

    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).businessMode).toBe("ONLINE_AND_OFFLINE");
    expect(await prismaBase.auditEvent.count({ where: { action: "tenant.business_mode_changed" } })).toBe(0);
  });

  it("the mode is per tenant: tenant A (dual) and tenant B (online-only) resolve different capabilities for their own users", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-b-mode", name: "B", slug: "tenant-b-mode" } });
    await setTestBusinessMode("ONLINE_AND_OFFLINE"); // tenant A = default
    const a = await createTestUser({ role: "OWNER" });
    const b = await createTestUser({ role: "OWNER", tenantId: "tenant-b-mode" });

    mockCookieStore.clear();
    await createSession(a.id);
    expect((await getCurrentUser())!.capabilities.has("offlineSales")).toBe(true);
    mockCookieStore.clear();
    await createSession(b.id);
    const ub = (await getCurrentUser())!;
    expect(ub.businessMode).toBe("ONLINE_ONLY");
    expect(ub.capabilities.size).toBe(0);
    expect(ub.permissions.has("sales.view")).toBe(false);
  });
});

describe("misc", () => {
  it("ensureDefaultOnlineChannelFor test helper is available for fixtures", async () => {
    expect((await ensureDefaultOnlineChannelFor(DEFAULT_TENANT_ID)).isDefault).toBe(true);
  });
});
