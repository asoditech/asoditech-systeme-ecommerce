import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createWarehouseAction,
  updateWarehouseAction,
  setWarehouseActiveAction,
} from "@/actions/warehouses";
import { adjustInventoryAction } from "@/actions/inventory";
import { changeTenantPlanAction } from "@/actions/plans";
import { resetDb, DEFAULT_TENANT_ID } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("warehouse CRUD actions", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  describe("authorization", () => {
    it("a WAREHOUSE user (inventory.adjust but not warehouses.manage) cannot create, update or (de)activate", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const created = await createWarehouseAction(formData({ name: "Dépôt Nord", type: "ENTREPOT" }));
      expect(created.ok).toBe(true);
      const id = created.ok ? created.data.id : "";

      mockCookieStore.clear();
      await loginAsTestUser({ role: "WAREHOUSE" });

      await expect(createWarehouseAction(formData({ name: "X", type: "ENTREPOT" }))).rejects.toThrow(/non autorisé/i);
      await expect(updateWarehouseAction(formData({ id, name: "Y", type: "MAGASIN" }))).rejects.toThrow(/non autorisé/i);
      await expect(setWarehouseActiveAction(formData({ id, isActive: "false" }))).rejects.toThrow(/non autorisé/i);

      expect(await prisma.warehouse.count()).toBe(1);
    });

    it("MANAGER and OWNER may manage warehouses", async () => {
      await loginAsTestUser({ role: "OWNER" });
      const r = await createWarehouseAction(formData({ name: "Magasin Centre", type: "MAGASIN", address: "12 av. Hassan II" }));
      expect(r.ok).toBe(true);
    });
  });

  describe("create", () => {
    it("creates a warehouse with defaults and an audit event, tagged INTERNE + createdBy", async () => {
      const user = await loginAsTestUser({ role: "MANAGER" });
      const r = await createWarehouseAction(formData({ name: "Dépôt Sud", type: "ENTREPOT" }));
      expect(r.ok).toBe(true);
      const id = r.ok ? r.data.id : "";

      const w = await prisma.warehouse.findUniqueOrThrow({ where: { id } });
      expect(w).toMatchObject({ name: "Dépôt Sud", type: "ENTREPOT", isActive: true, isDefault: false, source: "INTERNE", createdById: user.id });

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { entityType: "Warehouse", action: "warehouse.created" } });
      expect(audit.entityId).toBe(id);
    });
  });

  describe("update", () => {
    it("renames / retypes and audits; a provider-owned warehouse is rejected", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const created = await createWarehouseAction(formData({ name: "Ancien", type: "ENTREPOT" }));
      const id = created.ok ? created.data.id : "";

      const ok = await updateWarehouseAction(formData({ id, name: "Nouveau", type: "MAGASIN", address: "Rue X" }));
      expect(ok.ok).toBe(true);
      const w = await prisma.warehouse.findUniqueOrThrow({ where: { id } });
      expect(w).toMatchObject({ name: "Nouveau", type: "MAGASIN", address: "Rue X" });
      expect(await prisma.auditEvent.count({ where: { action: "warehouse.updated", entityId: id } })).toBe(1);

      const shopify = await prisma.warehouse.create({ data: { name: "Shopify Loc", source: "SHOPIFY", externalId: "gid://x" } });
      const bad = await updateWarehouseAction(formData({ id: shopify.id, name: "Hack", type: "ENTREPOT" }));
      expect(bad).toMatchObject({ ok: false });
    });
  });

  describe("activate / deactivate", () => {
    it("cannot deactivate the default warehouse", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      const def = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
      const r = await setWarehouseActiveAction(formData({ id: def.id, isActive: "false" }));
      expect(r).toMatchObject({ ok: false });
      expect((await prisma.warehouse.findUniqueOrThrow({ where: { id: def.id } })).isActive).toBe(true);
    });

    it("deactivating a warehouse audits it and blocks further stock adjustments there", async () => {
      await loginAsTestUser({ role: "MANAGER" });
      await prisma.warehouse.create({ data: { name: "Principal", isDefault: true } });
      const created = await createWarehouseAction(formData({ name: "Dépôt temporaire", type: "ENTREPOT" }));
      const id = created.ok ? created.data.id : "";
      const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
      await prisma.inventoryItem.create({ data: { warehouseId: id, productId: product.id, quantityOnHand: 5 } });

      const off = await setWarehouseActiveAction(formData({ id, isActive: "false" }));
      expect(off.ok).toBe(true);
      expect(await prisma.auditEvent.count({ where: { action: "warehouse.deactivated", entityId: id } })).toBe(1);

      const adj = await adjustInventoryAction(
        formData({ productId: product.id, warehouseId: id, type: "RECEPTION", quantity: "3", reason: "Livraison" })
      );
      expect(adj).toMatchObject({ ok: false });
      // stock untouched
      expect((await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: id } })).quantityOnHand).toBe(5);

      const on = await setWarehouseActiveAction(formData({ id, isActive: "true" }));
      expect(on.ok).toBe(true);
      expect(await prisma.auditEvent.count({ where: { action: "warehouse.activated", entityId: id } })).toBe(1);

      const adj2 = await adjustInventoryAction(
        formData({ productId: product.id, warehouseId: id, type: "RECEPTION", quantity: "3", reason: "Livraison" })
      );
      expect(adj2.ok).toBe(true);
    });
  });

  describe("warehouse-scoped adjustment", () => {
    it("adjusts exactly the targeted (warehouse, product) row when the product sits in two warehouses", async () => {
      await loginAsTestUser({ role: "WAREHOUSE" });
      const wa = await prisma.warehouse.create({ data: { name: "A", isDefault: true } });
      const wb = await prisma.warehouse.create({ data: { name: "B" } });
      const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
      await prisma.inventoryItem.create({ data: { warehouseId: wa.id, productId: product.id, quantityOnHand: 10 } });
      await prisma.inventoryItem.create({ data: { warehouseId: wb.id, productId: product.id, quantityOnHand: 20 } });

      const r = await adjustInventoryAction(
        formData({ productId: product.id, warehouseId: wb.id, type: "AJUSTEMENT_NEGATIF", quantity: "5", reason: "Inventaire" })
      );
      expect(r.ok).toBe(true);

      expect((await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: wa.id } })).quantityOnHand).toBe(10);
      expect((await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: wb.id } })).quantityOnHand).toBe(15);
    });

    it("rejects an adjustment against a non-existent warehouse", async () => {
      await loginAsTestUser({ role: "WAREHOUSE" });
      const product = await prisma.product.create({ data: { name: "P", sku: `S-${Math.random()}`, price: 10 } });
      const r = await adjustInventoryAction(
        formData({ productId: product.id, warehouseId: "nope", type: "RECEPTION", quantity: "1", reason: "x" })
      );
      expect(r).toMatchObject({ ok: false });
    });
  });
});

describe("createWarehouseAction — plan limit enforcement (docs/adr/0035 'Limit behaviour')", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("blocks creating a warehouse beyond the BUSINESS plan's limit (3 active warehouses), with a friendly upgrade message", async () => {
    await loginAsTestUser({ role: "OWNER" });
    // resetDb's bootstrap tenant already has its one default warehouse.
    const existing = await prisma.warehouse.count();
    for (let i = existing; i < 3; i++) {
      const r = await createWarehouseAction(formData({ name: `Entrepôt ${i}`, type: "ENTREPOT" }));
      expect(r.ok).toBe(true);
    }

    const overLimit = await createWarehouseAction(formData({ name: "Un de trop", type: "ENTREPOT" }));
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.error).toMatch(/forfait/i);
      expect(overLimit.error).toMatch(/3/);
    }

    // Nothing was half-created.
    expect(await prisma.warehouse.count({ where: { isActive: true } })).toBe(3);
  });

  it("never lets two concurrent createWarehouseAction calls both slip past the limit", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const existing = await prisma.warehouse.count();
    for (let i = existing; i < 2; i++) {
      await createWarehouseAction(formData({ name: `Entrepôt ${i}`, type: "ENTREPOT" }));
    }

    const results = await Promise.all([
      createWarehouseAction(formData({ name: "Concurrent A", type: "ENTREPOT" })),
      createWarehouseAction(formData({ name: "Concurrent B", type: "ENTREPOT" })),
    ]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded.length).toBe(1);
    expect(await prisma.warehouse.count({ where: { isActive: true } })).toBe(3);
  });

  it("a PRO tenant can create up to 10 active warehouses", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    await changeTenantPlanAction(formData({ tenantId: DEFAULT_TENANT_ID, planCode: "PRO" }));

    const existing = await prisma.warehouse.count();
    for (let i = existing; i < 10; i++) {
      const r = await createWarehouseAction(formData({ name: `Entrepôt ${i}`, type: "ENTREPOT" }));
      expect(r.ok).toBe(true);
    }
    const overLimit = await createWarehouseAction(formData({ name: "Un de trop", type: "ENTREPOT" }));
    expect(overLimit.ok).toBe(false);
  });
});
