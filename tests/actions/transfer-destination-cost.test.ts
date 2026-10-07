import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createStockTransferAction,
  updateStockTransferDraftAction,
  dispatchStockTransferAction,
  receiveStockTransferAction,
} from "@/actions/transfers";
import { updateTransferCostOverrideAction } from "@/actions/settings";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import type { UserRole } from "@prisma/client";

/**
 * Transfer purchase-cost override — Phase 1 (backend only). A transfer line may
 * carry a destination PURCHASE cost when the tenant setting is on; receiving
 * copies it to the TRANSFERT_ENTREE movement. The catalogue cost and every
 * selling price stay untouched.
 */

async function setOverride(on: boolean) {
  await prisma.businessSettings.upsert({
    where: { tenantId: "default" },
    update: { transferPurchaseCostOverrideEnabled: on },
    create: { transferPurchaseCostOverrideEnabled: on },
  });
}

async function seed() {
  const source = await prisma.warehouse.create({ data: { name: "Stock général", isDefault: true } });
  const dest = await prisma.warehouse.create({ data: { name: "Magasin Casablanca", type: "MAGASIN" } });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: `SKU-${Math.random()}`, price: 250, salePrice: 220, cost: 100, status: "ACTIF" },
  });
  await prisma.inventoryItem.create({ data: { warehouseId: source.id, productId: product.id, quantityOnHand: 20 } });

  const parent = await prisma.product.create({
    data: { name: "Polo", sku: `POLO-${Math.random()}`, price: 150, cost: 60, status: "ACTIF" },
  });
  const variation = await prisma.productVariation.create({
    data: { productId: parent.id, sku: `POLO-L-${Math.random()}`, attributes: { Taille: "L" }, price: 160, cost: 70 },
  });
  await prisma.inventoryItem.create({ data: { warehouseId: source.id, variationId: variation.id, quantityOnHand: 10 } });
  return { source, dest, product, parent, variation };
}

async function actor(role: UserRole, s: { source: { id: string }; dest: { id: string } }) {
  const user = await loginAsTestUser({ role });
  await grantLocationAccess(user.id, [s.source.id, s.dest.id]);
  return user;
}

const create = (
  s: { source: { id: string }; dest: { id: string }; product: { id: string }; variation: { id: string } },
  costs: { product?: number | null; variation?: number | null } = {}
) =>
  createStockTransferAction({
    sourceWarehouseId: s.source.id,
    destinationWarehouseId: s.dest.id,
    notes: "",
    lines: [
      { productId: s.product.id, variationId: null, quantitySent: 5, ...("product" in costs ? { destinationUnitCost: costs.product } : {}) },
      { productId: null, variationId: s.variation.id, quantitySent: 4, ...("variation" in costs ? { destinationUnitCost: costs.variation } : {}) },
    ],
  });

async function linesOf(transferId: string) {
  return prisma.stockTransferLine.findMany({ where: { stockTransferId: transferId }, orderBy: { variationId: { sort: "asc", nulls: "first" } } });
}

async function dispatchAndReceive(transferId: string, received?: (sent: number) => number) {
  expect((await dispatchStockTransferAction({ id: transferId })).ok).toBe(true);
  const lines = await linesOf(transferId);
  const r = await receiveStockTransferAction({
    id: transferId,
    lines: lines.map((l) => ({ lineId: l.id, quantityReceived: received ? received(l.quantitySent) : l.quantitySent })),
  });
  expect(r.ok).toBe(true);
}

const entreeMovements = (transferId: string) =>
  prisma.inventoryMovement.findMany({ where: { stockTransferId: transferId, type: "TRANSFERT_ENTREE" } });

describe("transfer destination purchase cost — Phase 1", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  describe("A — setting OFF (default): behaviour unchanged", () => {
    it("the setting defaults to off", async () => {
      expect((await prisma.businessSettings.findFirst())?.transferPurchaseCostOverrideEnabled ?? false).toBe(false);
      await setOverride(false);
      expect((await prisma.businessSettings.findFirstOrThrow()).transferPurchaseCostOverrideEnabled).toBe(false);
    });

    it("a transfer without cost works exactly as before: null line costs, null movement costs", async () => {
      const s = await seed();
      await actor("ADMIN", s);
      const created = await create(s);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect((await linesOf(created.data.id)).map((l) => l.destinationUnitCost)).toEqual([null, null]);

      await dispatchAndReceive(created.data.id);
      const movements = await prisma.inventoryMovement.findMany({ where: { stockTransferId: created.data.id } });
      expect(movements).toHaveLength(4);
      expect(movements.every((m) => m.unitCost === null)).toBe(true);
      const dst = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.dest.id, productId: s.product.id } });
      expect(dst.quantityOnHand).toBe(5);
    });

    it("a destination cost is refused server-side while the setting is off — nothing created", async () => {
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110 });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/pas activé/) });
      expect(await prisma.stockTransfer.count()).toBe(0);
    });

    it("an explicit null cost is accepted while off (no override)", async () => {
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: null });
      expect(r.ok).toBe(true);
    });
  });

  describe("B / C — setting ON: validation", () => {
    it("B — accepts a non-negative cost per line (product and variation), including 0", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110, variation: 0 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const [p, v] = await linesOf(r.data.id);
      expect(Number(p.destinationUnitCost)).toBe(110);
      expect(Number(v.destinationUnitCost)).toBe(0);
    });

    it("C — rejects a negative cost; nothing is created", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: -1 });
      expect(r.ok).toBe(false);
      expect(await prisma.stockTransfer.count()).toBe(0);
    });

    it("C — rejects a non-numeric or out-of-range cost", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      expect((await create(s, { product: Number.NaN })).ok).toBe(false);
      expect((await create(s, { product: 1e12 })).ok).toBe(false);
      expect(await prisma.stockTransfer.count()).toBe(0);
    });

    it("C — the database itself refuses a negative cost", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s);
      if (!r.ok) throw new Error(r.error);
      const [line] = await linesOf(r.data.id);
      await expect(prisma.stockTransferLine.update({ where: { id: line.id }, data: { destinationUnitCost: -5 } })).rejects.toThrow();
    });

    it("entering a cost requires finance.view — a transfer-only role is refused, without cost it still works", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("WAREHOUSE", s);
      const refused = await create(s, { product: 110 });
      expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/droit/) });
      expect((await create(s)).ok).toBe(true); // unchanged transfer permission
    });
  });

  describe("D / E / F — receiving", () => {
    it("D — TRANSFERT_ENTREE.unitCost = destinationUnitCost; TRANSFERT_SORTIE stays null", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110, variation: 75.5 });
      if (!r.ok) throw new Error(r.error);
      await dispatchAndReceive(r.data.id);

      const entree = await entreeMovements(r.data.id);
      const byItem = new Map(entree.map((m) => [m.inventoryItemId, m]));
      const pItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.dest.id, productId: s.product.id } });
      const vItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.dest.id, variationId: s.variation.id } });
      expect(Number(byItem.get(pItem.id)?.unitCost)).toBe(110);
      expect(Number(byItem.get(vItem.id)?.unitCost)).toBe(75.5);

      const sortie = await prisma.inventoryMovement.findMany({ where: { stockTransferId: r.data.id, type: "TRANSFERT_SORTIE" } });
      expect(sortie).toHaveLength(2);
      expect(sortie.every((m) => m.unitCost === null)).toBe(true);
    });

    it("D — a line without override keeps a null movement cost next to one with an override", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110 });
      if (!r.ok) throw new Error(r.error);
      await dispatchAndReceive(r.data.id);
      const vItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.dest.id, variationId: s.variation.id } });
      const vMove = (await entreeMovements(r.data.id)).find((m) => m.inventoryItemId === vItem.id);
      expect(vMove?.unitCost).toBeNull();
    });

    it("D — partial receive: the cost applies to the received quantity; 0 received → no movement, cost kept on the line", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110, variation: 80 });
      if (!r.ok) throw new Error(r.error);
      expect((await dispatchStockTransferAction({ id: r.data.id })).ok).toBe(true);
      const [p, v] = await linesOf(r.data.id);
      const res = await receiveStockTransferAction({
        id: r.data.id,
        lines: [
          { lineId: p.id, quantityReceived: 3 },
          { lineId: v.id, quantityReceived: 0 },
        ],
      });
      expect(res.ok).toBe(true);
      const entree = await entreeMovements(r.data.id);
      expect(entree).toHaveLength(1);
      expect(entree[0]).toMatchObject({ quantity: 3 });
      expect(Number(entree[0].unitCost)).toBe(110);
      expect(Number((await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: v.id } })).destinationUnitCost)).toBe(80);
    });

    it("E — Product.cost / ProductVariation.cost and every selling price stay unchanged", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110, variation: 90 });
      if (!r.ok) throw new Error(r.error);
      await dispatchAndReceive(r.data.id);

      const product = await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } });
      expect(Number(product.cost)).toBe(100);
      expect(Number(product.price)).toBe(250);
      expect(Number(product.salePrice)).toBe(220);
      const parent = await prisma.product.findUniqueOrThrow({ where: { id: s.parent.id } });
      expect(Number(parent.cost)).toBe(60);
      const variation = await prisma.productVariation.findUniqueOrThrow({ where: { id: s.variation.id } });
      expect(Number(variation.cost)).toBe(70);
      expect(Number(variation.price)).toBe(160);
      expect(variation.salePrice).toBeNull();
    });

    it("E — WEIGHTED_AVERAGE costing is not triggered by a transfer receive", async () => {
      await prisma.businessSettings.upsert({
        where: { tenantId: "default" },
        update: { transferPurchaseCostOverrideEnabled: true, costingMethod: "WEIGHTED_AVERAGE" },
        create: { transferPurchaseCostOverrideEnabled: true, costingMethod: "WEIGHTED_AVERAGE" },
      });
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 200 });
      if (!r.ok) throw new Error(r.error);
      await dispatchAndReceive(r.data.id);
      expect(Number((await prisma.product.findUniqueOrThrow({ where: { id: s.product.id } })).cost)).toBe(100);
    });

    it("F — the line keeps destinationUnitCost after receive, and after the setting is turned off", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110 });
      if (!r.ok) throw new Error(r.error);
      await dispatchAndReceive(r.data.id);
      await setOverride(false);
      const [p] = await linesOf(r.data.id);
      expect(Number(p.destinationUnitCost)).toBe(110);
      expect(p.quantityReceived).toBe(5);
      expect(Number((await entreeMovements(r.data.id)).find((m) => m.unitCost !== null)?.unitCost)).toBe(110);
    });

    it("a cost recorded while on is still applied if the setting is turned off before receive", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110 });
      if (!r.ok) throw new Error(r.error);
      await setOverride(false);
      await dispatchAndReceive(r.data.id);
      const pItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.dest.id, productId: s.product.id } });
      expect(Number((await entreeMovements(r.data.id)).find((m) => m.inventoryItemId === pItem.id)?.unitCost)).toBe(110);
    });

    it("a failed receive leaves no partial state (cost line, movements, status)", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110 });
      if (!r.ok) throw new Error(r.error);
      expect((await dispatchStockTransferAction({ id: r.data.id })).ok).toBe(true);
      const [p, v] = await linesOf(r.data.id);
      const bad = await receiveStockTransferAction({
        id: r.data.id,
        lines: [
          { lineId: p.id, quantityReceived: 5 },
          { lineId: v.id, quantityReceived: 99 }, // above sent
        ],
      });
      expect(bad.ok).toBe(false);
      expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id: r.data.id } })).status).toBe("EN_TRANSIT");
      expect(await entreeMovements(r.data.id)).toHaveLength(0);
      expect((await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: p.id } })).quantityReceived).toBeNull();
    });
  });

  describe("draft edit", () => {
    it("an edit that does not mention the cost keeps it (« inchangé »); null clears it; a number replaces it", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110 });
      if (!r.ok) throw new Error(r.error);
      const edit = (cost?: number | null) =>
        updateStockTransferDraftAction({
          id: r.data.id,
          notes: "",
          lines: [{ productId: s.product.id, variationId: null, quantitySent: 6, ...(cost === undefined ? {} : { destinationUnitCost: cost }) }],
        });

      expect((await edit()).ok).toBe(true);
      expect(Number((await linesOf(r.data.id))[0].destinationUnitCost)).toBe(110);
      expect((await edit(120)).ok).toBe(true);
      expect(Number((await linesOf(r.data.id))[0].destinationUnitCost)).toBe(120);
      expect((await edit(null)).ok).toBe(true);
      expect((await linesOf(r.data.id))[0].destinationUnitCost).toBeNull();
    });

    it("a role without finance.view can edit quantities (cost kept) but can neither set nor clear a cost", async () => {
      await setOverride(true);
      const s = await seed();
      await actor("ADMIN", s);
      const r = await create(s, { product: 110 });
      if (!r.ok) throw new Error(r.error);

      await actor("WAREHOUSE", s);
      const lines = (cost?: number | null) => [
        { productId: s.product.id, variationId: null, quantitySent: 7, ...(cost === undefined ? {} : { destinationUnitCost: cost }) },
      ];
      expect((await updateStockTransferDraftAction({ id: r.data.id, notes: "", lines: lines() })).ok).toBe(true);
      const [kept] = await linesOf(r.data.id);
      expect(kept.quantitySent).toBe(7);
      expect(Number(kept.destinationUnitCost)).toBe(110);

      expect((await updateStockTransferDraftAction({ id: r.data.id, notes: "", lines: lines(90) })).ok).toBe(false);
      expect((await updateStockTransferDraftAction({ id: r.data.id, notes: "", lines: lines(null) })).ok).toBe(false);
      expect(Number((await linesOf(r.data.id))[0].destinationUnitCost)).toBe(110);
    });
  });

  describe("setting action", () => {
    it("settings.manage toggles the flag with an audit event; other roles are refused", async () => {
      const fd = (v: string) => {
        const f = new FormData();
        f.set("transferPurchaseCostOverrideEnabled", v);
        return f;
      };
      await loginAsTestUser({ role: "WAREHOUSE" });
      await expect(updateTransferCostOverrideAction(fd("true"))).rejects.toThrow(/non autorisé/i);

      await loginAsTestUser({ role: "ADMIN" });
      expect((await updateTransferCostOverrideAction(fd("true"))).ok).toBe(true);
      expect((await prisma.businessSettings.findFirstOrThrow()).transferPurchaseCostOverrideEnabled).toBe(true);
      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "settings.updated" }, orderBy: { createdAt: "desc" } });
      expect(audit.newValue).toMatchObject({ transferPurchaseCostOverrideEnabled: true });
      expect((await updateTransferCostOverrideAction(fd("false"))).ok).toBe(true);
      expect((await prisma.businessSettings.findFirstOrThrow()).transferPurchaseCostOverrideEnabled).toBe(false);
    });
  });
});
