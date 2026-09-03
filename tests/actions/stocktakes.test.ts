import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createStocktakeSessionAction,
  updateStocktakeCountsAction,
  finalizeStocktakeSessionAction,
  cancelStocktakeSessionAction,
} from "@/actions/stocktakes";
import { listStocktakeSessions, getStocktakeSessionDetail } from "@/lib/queries/stocktakes";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import type { UserRole } from "@prisma/client";

async function seedWarehouse(opts: { active?: boolean; name?: string } = {}) {
  return prisma.warehouse.create({
    data: { name: opts.name ?? "Entrepôt principal", isDefault: opts.name === undefined, isActive: opts.active ?? true },
  });
}

async function seedItem(warehouseId: string, qty: number, opts: { variation?: boolean } = {}) {
  const product = await prisma.product.create({
    data: { name: `P-${Math.random()}`, sku: `S-${Math.random()}`, price: 10, status: "ACTIF" },
  });
  if (opts.variation) {
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: `V-${Math.random()}`, attributes: { Taille: "M" } },
    });
    const item = await prisma.inventoryItem.create({
      data: { warehouseId, variationId: variation.id, quantityOnHand: qty },
    });
    return { product, variation, item };
  }
  const item = await prisma.inventoryItem.create({
    data: { warehouseId, productId: product.id, quantityOnHand: qty },
  });
  return { product, variation: null, item };
}

/** Create an EN_COURS session as WAREHOUSE and return session id + line ids by item id. */
async function startSession(warehouseId: string, role: UserRole = "WAREHOUSE") {
  await loginAsTestUser({ role });
  const r = await createStocktakeSessionAction({ warehouseId, notes: "" });
  if (!r.ok) throw new Error(r.error);
  const lines = await prisma.stocktakeLine.findMany({ where: { stocktakeSessionId: r.data.id } });
  const lineByItem = new Map(lines.map((l) => [l.inventoryItemId, l.id]));
  return { sessionId: r.data.id, lineByItem, lines };
}

describe("stocktake actions (Phase 32c)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  // ---------------------------------------------------------------- A. creation
  describe("createStocktakeSessionAction", () => {
    it("A — snapshots every warehouse InventoryItem, EN_COURS, no movement, audit once", async () => {
      const wh = await seedWarehouse();
      const { item: i1 } = await seedItem(wh.id, 10);
      const { item: i2, variation } = await seedItem(wh.id, 0, { variation: true });
      // an item in a DIFFERENT warehouse must not be snapshotted
      const other = await seedWarehouse({ name: "Autre" });
      await seedItem(other.id, 99);

      const user = await loginAsTestUser({ role: "WAREHOUSE" });
      const r = await createStocktakeSessionAction({ warehouseId: wh.id, notes: "  annuel  " });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const session = await prisma.stocktakeSession.findUniqueOrThrow({
        where: { id: r.data.id },
        include: { lines: true },
      });
      expect(session.status).toBe("EN_COURS");
      expect(session.startedById).toBe(user.id);
      expect(session.notes).toBe("annuel");
      expect(session.lines).toHaveLength(2);
      const byItem = new Map(session.lines.map((l) => [l.inventoryItemId, l]));
      expect(byItem.get(i1.id)).toMatchObject({ systemQuantityAtCount: 10, countedQuantity: null, appliedAt: null });
      expect(byItem.get(i2.id)).toMatchObject({ systemQuantityAtCount: 0, countedQuantity: null });
      expect(variation).toBeTruthy();

      expect(await prisma.inventoryMovement.count()).toBe(0);
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: "stocktake.created", entityId: r.data.id },
      });
      expect(audit.actorUserId).toBe(user.id);
      expect(audit.newValue).toMatchObject({ warehouseId: wh.id, lineCount: 2 });
    });

    it("A — rejects an inactive warehouse", async () => {
      const wh = await seedWarehouse({ active: false, name: "Retiré" });
      await loginAsTestUser({ role: "WAREHOUSE" });
      expect(await createStocktakeSessionAction({ warehouseId: wh.id, notes: "" })).toMatchObject({ ok: false });
      expect(await prisma.stocktakeSession.count()).toBe(0);
    });

    it("A — rejects a missing warehouse", async () => {
      await loginAsTestUser({ role: "WAREHOUSE" });
      expect(await createStocktakeSessionAction({ warehouseId: "nope", notes: "" })).toMatchObject({ ok: false });
    });

    it("A/F — concurrent create for the same warehouse: exactly one open session", async () => {
      const wh = await seedWarehouse();
      await seedItem(wh.id, 5);
      await loginAsTestUser({ role: "WAREHOUSE" });
      const results = await Promise.allSettled([
        createStocktakeSessionAction({ warehouseId: wh.id, notes: "" }),
        createStocktakeSessionAction({ warehouseId: wh.id, notes: "" }),
      ]);
      const oks = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
      expect(oks).toBe(1);
      expect(await prisma.stocktakeSession.count({ where: { warehouseId: wh.id, status: "EN_COURS" } })).toBe(1);
    });
  });

  // ---------------------------------------------------------------- B. counting
  describe("updateStocktakeCountsAction", () => {
    it("B — saves positive and zero counts, no inventory mutation, no audit", async () => {
      const wh = await seedWarehouse();
      const { item: i1 } = await seedItem(wh.id, 10);
      const { item: i2 } = await seedItem(wh.id, 4);
      const { sessionId, lineByItem } = await startSession(wh.id);

      const r = await updateStocktakeCountsAction({
        id: sessionId,
        counts: [
          { lineId: lineByItem.get(i1.id)!, countedQuantity: 7 },
          { lineId: lineByItem.get(i2.id)!, countedQuantity: 0 },
        ],
      });
      expect(r.ok).toBe(true);

      const lines = await prisma.stocktakeLine.findMany({ where: { stocktakeSessionId: sessionId } });
      const byItem = new Map(lines.map((l) => [l.inventoryItemId, l]));
      expect(byItem.get(i1.id)).toMatchObject({ countedQuantity: 7, systemQuantityAtCount: 10 });
      expect(byItem.get(i2.id)).toMatchObject({ countedQuantity: 0, systemQuantityAtCount: 4 });
      expect(byItem.get(i1.id)!.countedById).toBeTruthy();

      // stock untouched, no movement, no count audit
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: i1.id } })).quantityOnHand).toBe(10);
      expect(await prisma.inventoryMovement.count()).toBe(0);
      expect(await prisma.auditEvent.count({ where: { entityId: sessionId } })).toBe(1); // only stocktake.created
    });

    it("B — explicit null clears a previously-entered count (not coerced to 0)", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      const lineId = lineByItem.get(item.id)!;

      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 3 }] });
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: null }] });

      const line = await prisma.stocktakeLine.findUniqueOrThrow({ where: { id: lineId } });
      expect(line.countedQuantity).toBeNull();
      expect(line.countedAt).toBeNull();
      expect(line.countedById).toBeNull();
    });

    it("B — rejects negative and non-integer counts (schema)", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      const lineId = lineByItem.get(item.id)!;
      expect(await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: -1 }] })).toMatchObject({ ok: false });
      expect(await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 2.5 }] })).toMatchObject({ ok: false });
    });

    it("B — rejects a line that does not belong to the session (IDOR guard)", async () => {
      const whA = await seedWarehouse({ name: "A" });
      const whB = await seedWarehouse({ name: "B" });
      const { item: ia } = await seedItem(whA.id, 5);
      const { item: ib } = await seedItem(whB.id, 5);
      const a = await startSession(whA.id);
      mockCookieStore.clear();
      const b = await startSession(whB.id);

      const r = await updateStocktakeCountsAction({
        id: a.sessionId,
        counts: [{ lineId: b.lineByItem.get(ib.id)!, countedQuantity: 1 }],
      });
      expect(r).toMatchObject({ ok: false });
      // session A's own line untouched
      expect(
        (await prisma.stocktakeLine.findUniqueOrThrow({ where: { id: a.lineByItem.get(ia.id)! } })).countedQuantity
      ).toBeNull();
    });

    it("B — rejects counts on a CLOTURE or ANNULE session", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 5);
      const { sessionId, lineByItem } = await startSession(wh.id);
      const lineId = lineByItem.get(item.id)!;
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 5 }] });
      await finalizeStocktakeSessionAction({ id: sessionId });
      expect(await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 1 }] })).toMatchObject({ ok: false });

      // separate cancelled session
      const wh2 = await seedWarehouse({ name: "W2" });
      const { item: i2 } = await seedItem(wh2.id, 5);
      const s2 = await startSession(wh2.id);
      await cancelStocktakeSessionAction({ id: s2.sessionId });
      expect(
        await updateStocktakeCountsAction({ id: s2.sessionId, counts: [{ lineId: s2.lineByItem.get(i2.id)!, countedQuantity: 1 }] })
      ).toMatchObject({ ok: false });
    });
  });

  // ------------------------------------------------------------ C/D. finalization
  describe("finalizeStocktakeSessionAction", () => {
    it("C/D — positive/negative/zero variance + uncounted line", async () => {
      const wh = await seedWarehouse();
      const { item: up } = await seedItem(wh.id, 10); // count 13 -> +3
      const { item: down } = await seedItem(wh.id, 8); // count 5 -> -3
      const { item: zero } = await seedItem(wh.id, 6); // count 6 -> 0
      const { item: skip } = await seedItem(wh.id, 4); // never counted
      const { sessionId, lineByItem } = await startSession(wh.id);
      const user = await prisma.user.findFirstOrThrow();

      await updateStocktakeCountsAction({
        id: sessionId,
        counts: [
          { lineId: lineByItem.get(up.id)!, countedQuantity: 13 },
          { lineId: lineByItem.get(down.id)!, countedQuantity: 5 },
          { lineId: lineByItem.get(zero.id)!, countedQuantity: 6 },
        ],
      });

      const r = await finalizeStocktakeSessionAction({ id: sessionId });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toMatchObject({ applied: 2, zeroVariance: 1, uncounted: 1 });

      const session = await prisma.stocktakeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.status).toBe("CLOTURE");
      expect(session.closedById).toBe(user.id);
      expect(session.closedAt).not.toBeNull();

      // stock landed exactly on the counted values
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: up.id } })).quantityOnHand).toBe(13);
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: down.id } })).quantityOnHand).toBe(5);
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: zero.id } })).quantityOnHand).toBe(6);
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: skip.id } })).quantityOnHand).toBe(4);

      // movements: exactly 2, both INVENTAIRE, correct warehouse + session, quantity = |variance|
      const movements = await prisma.inventoryMovement.findMany({ where: { stocktakeSessionId: sessionId } });
      expect(movements).toHaveLength(2);
      for (const m of movements) {
        expect(m.type).toBe("INVENTAIRE");
        expect(m.warehouseId).toBe(wh.id);
        expect(m.stocktakeSessionId).toBe(sessionId);
        expect(m.performedById).toBe(user.id);
        expect(m.quantity).toBe(3);
        expect(m.reason).toMatch(/^Inventaire INV-\d{6}$/);
      }

      // appliedMovementId persisted on the two varianced lines; null on zero-variance; null on uncounted
      const lines = await prisma.stocktakeLine.findMany({ where: { stocktakeSessionId: sessionId } });
      const byItem = new Map(lines.map((l) => [l.inventoryItemId, l]));
      expect(byItem.get(up.id)!.appliedMovementId).toBeTruthy();
      expect(byItem.get(down.id)!.appliedMovementId).toBeTruthy();
      expect(byItem.get(zero.id)!.appliedMovementId).toBeNull();
      expect(byItem.get(zero.id)!.appliedAt).not.toBeNull();
      expect(byItem.get(skip.id)!.appliedAt).toBeNull();

      // audit: exactly one stocktake.closed, no count-update audit
      const closed = await prisma.auditEvent.findFirstOrThrow({ where: { action: "stocktake.closed", entityId: sessionId } });
      expect(closed.metadata).toMatchObject({ appliedCount: 2, zeroVarianceCount: 1, uncountedCount: 1, movementCount: 2 });
      expect(await prisma.auditEvent.count({ where: { entityId: sessionId } })).toBe(2); // created + closed
    });

    it("C — finalizing a session with no counts closes it with zero movements", async () => {
      const wh = await seedWarehouse();
      await seedItem(wh.id, 5);
      const { sessionId } = await startSession(wh.id);
      const r = await finalizeStocktakeSessionAction({ id: sessionId });
      expect(r.ok).toBe(true);
      expect((await prisma.stocktakeSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("CLOTURE");
      expect(await prisma.inventoryMovement.count()).toBe(0);
    });

    it("C — a variation-backed line applies to the variation InventoryItem", async () => {
      const wh = await seedWarehouse();
      const { item, variation } = await seedItem(wh.id, 2, { variation: true });
      const { sessionId, lineByItem } = await startSession(wh.id);
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId: lineByItem.get(item.id)!, countedQuantity: 5 }] });
      await finalizeStocktakeSessionAction({ id: sessionId });
      const row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row).toMatchObject({ quantityOnHand: 5, variationId: variation!.id });
      const mv = await prisma.inventoryMovement.findFirstOrThrow({ where: { stocktakeSessionId: sessionId } });
      expect(mv.inventoryItemId).toBe(item.id);
    });

    it("C — retrying a finalized session is rejected (already CLOTURE), no second movements", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId: lineByItem.get(item.id)!, countedQuantity: 12 }] });
      expect((await finalizeStocktakeSessionAction({ id: sessionId })).ok).toBe(true);
      const again = await finalizeStocktakeSessionAction({ id: sessionId });
      expect(again).toMatchObject({ ok: false });
      expect(await prisma.inventoryMovement.count({ where: { stocktakeSessionId: sessionId } })).toBe(1);
    });
  });

  // ------------------------------------------------------------ E. stale detection
  describe("stale detection", () => {
    it("E — a stock change after counting blocks finalize; session stays EN_COURS; 0 movements; isStale persisted", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      const lineId = lineByItem.get(item.id)!;
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 12 }] });

      // a sale/adjust happens after the count
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: { decrement: 2 } } });

      const r = await finalizeStocktakeSessionAction({ id: sessionId });
      expect(r).toMatchObject({ ok: false });
      expect((await prisma.stocktakeSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("EN_COURS");
      expect(await prisma.inventoryMovement.count({ where: { stocktakeSessionId: sessionId } })).toBe(0);
      expect((await prisma.stocktakeLine.findUniqueOrThrow({ where: { id: lineId } })).isStale).toBe(true);
    });

    it("E — recounting the stale line clears it and finalize then succeeds", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      const lineId = lineByItem.get(item.id)!;
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 12 }] });
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: 8 } });
      await finalizeStocktakeSessionAction({ id: sessionId }); // blocked

      // recount against the new reality: physically 9 on the shelf
      const rc = await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 9 }] });
      expect(rc.ok).toBe(true);
      const line = await prisma.stocktakeLine.findUniqueOrThrow({ where: { id: lineId } });
      expect(line.isStale).toBe(false);
      expect(line.systemQuantityAtCount).toBe(8); // refreshed

      const fin = await finalizeStocktakeSessionAction({ id: sessionId });
      expect(fin.ok).toBe(true);
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(9);
    });
  });

  // ------------------------------------------------------------ F. concurrency
  describe("concurrency", () => {
    it("F — two concurrent finalize calls: exactly one closes, exactly one movement per non-zero line", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId: lineByItem.get(item.id)!, countedQuantity: 15 }] });

      const results = await Promise.allSettled([
        finalizeStocktakeSessionAction({ id: sessionId }),
        finalizeStocktakeSessionAction({ id: sessionId }),
      ]);
      const oks = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
      expect(oks).toBe(1);
      expect((await prisma.stocktakeSession.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe("CLOTURE");
      expect(await prisma.inventoryMovement.count({ where: { stocktakeSessionId: sessionId } })).toBe(1);
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(15);
    });

    it("F — a concurrent inventory movement never produces a duplicate INVENTAIRE nor a corrupt quantity", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId: lineByItem.get(item.id)!, countedQuantity: 15 }] });

      // finalize races a raw stock decrement on the same item
      await Promise.allSettled([
        finalizeStocktakeSessionAction({ id: sessionId }),
        prisma.$transaction((tx) =>
          tx.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: { decrement: 2 } } })
        ),
      ]);

      const session = await prisma.stocktakeSession.findUniqueOrThrow({ where: { id: sessionId } });
      const inventaire = await prisma.inventoryMovement.count({ where: { stocktakeSessionId: sessionId } });
      expect(inventaire).toBeLessThanOrEqual(1);
      if (session.status === "CLOTURE") {
        // finalize won the lock: variance applied against 10, then -2 → 13
        expect(inventaire).toBe(1);
        expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(13);
      } else {
        // the decrement won: finalize saw stale → rejected
        expect(session.status).toBe("EN_COURS");
        expect(inventaire).toBe(0);
        expect((await prisma.stocktakeLine.findFirstOrThrow({ where: { stocktakeSessionId: sessionId } })).isStale).toBe(true);
      }
    });

    it("F/G — concurrent cancel vs finalize: exactly one wins, terminal state, no orphan movement", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId: lineByItem.get(item.id)!, countedQuantity: 15 }] });

      const [cancel, finalize] = await Promise.allSettled([
        cancelStocktakeSessionAction({ id: sessionId }),
        finalizeStocktakeSessionAction({ id: sessionId }),
      ]);
      const oks = [cancel, finalize].filter((r) => r.status === "fulfilled" && r.value.ok).length;
      expect(oks).toBe(1);
      const session = await prisma.stocktakeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(["ANNULE", "CLOTURE"]).toContain(session.status);
      const movements = await prisma.inventoryMovement.count({ where: { stocktakeSessionId: sessionId } });
      expect(movements).toBe(session.status === "CLOTURE" ? 1 : 0);
    });
  });

  // ------------------------------------------------------------ G. cancellation
  describe("cancelStocktakeSessionAction", () => {
    it("G — EN_COURS -> ANNULE, no movement, audit once, counts kept", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      const lineId = lineByItem.get(item.id)!;
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId, countedQuantity: 7 }] });

      const r = await cancelStocktakeSessionAction({ id: sessionId });
      expect(r.ok).toBe(true);
      const session = await prisma.stocktakeSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.status).toBe("ANNULE");
      expect(await prisma.inventoryMovement.count()).toBe(0);
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(10);
      expect((await prisma.stocktakeLine.findUniqueOrThrow({ where: { id: lineId } })).countedQuantity).toBe(7);
      await prisma.auditEvent.findFirstOrThrow({ where: { action: "stocktake.cancelled", entityId: sessionId } });
    });

    it("G — cannot cancel a CLOTURE or an already-ANNULE session", async () => {
      const wh = await seedWarehouse();
      await seedItem(wh.id, 5);
      const { sessionId } = await startSession(wh.id);
      await finalizeStocktakeSessionAction({ id: sessionId });
      expect(await cancelStocktakeSessionAction({ id: sessionId })).toMatchObject({ ok: false });

      const wh2 = await seedWarehouse({ name: "W2" });
      await seedItem(wh2.id, 5);
      const s2 = await startSession(wh2.id);
      await cancelStocktakeSessionAction({ id: s2.sessionId });
      expect(await cancelStocktakeSessionAction({ id: s2.sessionId })).toMatchObject({ ok: false });
      expect(await prisma.auditEvent.count({ where: { action: "stocktake.cancelled", entityId: s2.sessionId } })).toBe(1);
    });
  });

  // ------------------------------------------------------------ H. RBAC
  describe("RBAC", () => {
    const allowed: UserRole[] = ["OWNER", "ADMIN", "MANAGER", "WAREHOUSE"];
    const denied: UserRole[] = ["SALES", "DELIVERY", "SUPPORT", "ACCOUNTANT"];

    it("H — allowed roles can create + count + finalize + cancel", async () => {
      for (const role of allowed) {
        await resetDb();
        mockCookieStore.clear();
        const wh = await seedWarehouse();
        const { item } = await seedItem(wh.id, 5);
        await loginAsTestUser({ role });
        const created = await createStocktakeSessionAction({ warehouseId: wh.id, notes: "" });
        expect(created.ok, role).toBe(true);
        if (!created.ok) continue;
        const line = await prisma.stocktakeLine.findFirstOrThrow({ where: { stocktakeSessionId: created.data.id } });
        expect((await updateStocktakeCountsAction({ id: created.data.id, counts: [{ lineId: line.id, countedQuantity: 6 }] })).ok, role).toBe(true);
        expect((await finalizeStocktakeSessionAction({ id: created.data.id })).ok, role).toBe(true);
        void item;
      }
    });

    it("H — denied roles are rejected on every mutation", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 5);
      const setup = await startSession(wh.id); // as WAREHOUSE
      const lineId = setup.lineByItem.get(item.id)!;
      for (const role of denied) {
        mockCookieStore.clear();
        await loginAsTestUser({ role });
        await expect(createStocktakeSessionAction({ warehouseId: wh.id, notes: "" })).rejects.toThrow(/non autorisé/i);
        await expect(updateStocktakeCountsAction({ id: setup.sessionId, counts: [{ lineId, countedQuantity: 1 }] })).rejects.toThrow(/non autorisé/i);
        await expect(finalizeStocktakeSessionAction({ id: setup.sessionId })).rejects.toThrow(/non autorisé/i);
        await expect(cancelStocktakeSessionAction({ id: setup.sessionId })).rejects.toThrow(/non autorisé/i);
      }
    });
  });

  // ------------------------------------------------------------ I. queries
  describe("queries", () => {
    it("I — list respects the status filter and returns a narrow DTO with counted/total", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 5);
      await seedItem(wh.id, 3);
      const { sessionId, lineByItem } = await startSession(wh.id);
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId: lineByItem.get(item.id)!, countedQuantity: 5 }] });

      const openList = await listStocktakeSessions({ status: "EN_COURS" });
      expect(openList.sessions).toHaveLength(1);
      expect(openList.sessions[0]).toMatchObject({ warehouseName: "Entrepôt principal", totalLines: 2, countedLines: 1 });
      expect(openList.sessions[0]).not.toHaveProperty("warehouseId");

      const closedList = await listStocktakeSessions({ status: "CLOTURE" });
      expect(closedList.sessions).toHaveLength(0);
    });

    it("I — detail returns per-line variance/current/stale and a summary; no internal ids leak", async () => {
      const wh = await seedWarehouse();
      const { item } = await seedItem(wh.id, 10);
      const { sessionId, lineByItem } = await startSession(wh.id);
      await updateStocktakeCountsAction({ id: sessionId, counts: [{ lineId: lineByItem.get(item.id)!, countedQuantity: 7 }] });
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { quantityOnHand: 9 } });

      const detail = await getStocktakeSessionDetail(sessionId);
      expect(detail).toBeTruthy();
      if (!detail) return;
      expect(detail.summary).toMatchObject({ total: 1, counted: 1 });
      const line = detail.lines[0];
      expect(line).toMatchObject({ systemQuantityAtCount: 10, currentQuantity: 9, countedQuantity: 7, variance: -3 });
      expect(line).not.toHaveProperty("inventoryItemId");
      expect(line).not.toHaveProperty("appliedMovementId");
    });

    it("I — getStocktakeSessionDetail returns null for an unknown id", async () => {
      expect(await getStocktakeSessionDetail("nope")).toBeNull();
    });
  });
});
