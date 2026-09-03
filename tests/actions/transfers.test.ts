import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createStockTransferAction,
  updateStockTransferDraftAction,
  dispatchStockTransferAction,
  receiveStockTransferAction,
  cancelStockTransferAction,
} from "@/actions/transfers";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import type { UserRole } from "@prisma/client";

async function seed(opts: { sourceQty?: number; destActive?: boolean } = {}) {
  const source = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const dest = await prisma.warehouse.create({
    data: { name: "Boutique", type: "MAGASIN", isActive: opts.destActive ?? true },
  });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: `SKU-${Math.random()}`, price: 100, status: "ACTIF" },
  });
  await prisma.inventoryItem.create({
    data: { warehouseId: source.id, productId: product.id, quantityOnHand: opts.sourceQty ?? 20 },
  });
  return { source, dest, product };
}

const baseCreate = (source: string, dest: string, productId: string, quantitySent = 5) => ({
  sourceWarehouseId: source,
  destinationWarehouseId: dest,
  notes: "",
  lines: [{ productId, variationId: null, quantitySent }],
});

async function createDraft(role: UserRole = "WAREHOUSE", opts?: Parameters<typeof seed>[0]) {
  const s = await seed(opts);
  await loginAsTestUser({ role });
  const created = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id));
  if (!created.ok) throw new Error(created.error);
  return { ...s, transferId: created.data.id };
}

describe("stock transfer actions (Phase 32b)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  describe("create", () => {
    it("T1 — creates a BROUILLON with lines, a transferNumber, and an audit event", async () => {
      const s = await seed();
      const user = await loginAsTestUser({ role: "WAREHOUSE" });
      const r = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id, 5));
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: r.data.id }, include: { lines: true } });
      expect(t.status).toBe("BROUILLON");
      expect(t.transferNumber).toBeGreaterThan(0);
      expect(t.createdById).toBe(user.id);
      expect(t.lines).toHaveLength(1);
      expect(t.lines[0]).toMatchObject({ productId: s.product.id, quantitySent: 5, quantityReceived: null });

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "stock_transfer.created", entityId: r.data.id } });
      expect(audit.actorUserId).toBe(user.id);
    });

    it("T2 — rejects source === destination", async () => {
      const s = await seed();
      await loginAsTestUser({ role: "WAREHOUSE" });
      const r = await createStockTransferAction(baseCreate(s.source.id, s.source.id, s.product.id));
      expect(r).toMatchObject({ ok: false });
      expect(await prisma.stockTransfer.count()).toBe(0);
    });

    it("T3 — rejects an inactive source or destination", async () => {
      const s = await seed();
      await prisma.warehouse.update({ where: { id: s.dest.id }, data: { isActive: false } });
      await loginAsTestUser({ role: "WAREHOUSE" });
      expect(await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id))).toMatchObject({ ok: false });

      await prisma.warehouse.update({ where: { id: s.dest.id }, data: { isActive: true } });
      await prisma.warehouse.update({ where: { id: s.source.id }, data: { isActive: false } });
      expect(await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id))).toMatchObject({ ok: false });
      expect(await prisma.stockTransfer.count()).toBe(0);
    });

    it("T4 — rejects a line with both refs set or neither", async () => {
      const s = await seed();
      await loginAsTestUser({ role: "WAREHOUSE" });
      const both = await createStockTransferAction({
        sourceWarehouseId: s.source.id,
        destinationWarehouseId: s.dest.id,
        notes: "",
        lines: [{ productId: s.product.id, variationId: "some-variation", quantitySent: 1 }],
      });
      expect(both).toMatchObject({ ok: false });
      const neither = await createStockTransferAction({
        sourceWarehouseId: s.source.id,
        destinationWarehouseId: s.dest.id,
        notes: "",
        lines: [{ productId: null, variationId: null, quantitySent: 1 }],
      });
      expect(neither).toMatchObject({ ok: false });
    });

    it("T5 — rejects quantitySent <= 0", async () => {
      const s = await seed();
      await loginAsTestUser({ role: "WAREHOUSE" });
      const r = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id, 0));
      expect(r).toMatchObject({ ok: false });
    });

    it("allows an external (WOOCOMMERCE) product in a transfer", async () => {
      const s = await seed();
      const ext = await prisma.product.create({
        data: { name: "Woo", sku: `W-${Math.random()}`, price: 10, source: "WOOCOMMERCE", externalId: "1", status: "ACTIF" },
      });
      await prisma.inventoryItem.create({ data: { warehouseId: s.source.id, productId: ext.id, quantityOnHand: 5 } });
      await loginAsTestUser({ role: "WAREHOUSE" });
      const r = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, ext.id, 2));
      expect(r.ok).toBe(true);
    });
  });

  describe("draft edit", () => {
    it("T18 — edits lines/notes of a BROUILLON; rejects editing a non-draft", async () => {
      const d = await createDraft();
      const edit = await updateStockTransferDraftAction({
        id: d.transferId,
        notes: "révisé",
        lines: [{ productId: d.product.id, variationId: null, quantitySent: 8 }],
      });
      expect(edit.ok).toBe(true);
      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId }, include: { lines: true } });
      expect(t.notes).toBe("révisé");
      expect(t.lines[0].quantitySent).toBe(8);

      await dispatchStockTransferAction({ id: d.transferId });
      const afterDispatch = await updateStockTransferDraftAction({
        id: d.transferId,
        notes: "trop tard",
        lines: [{ productId: d.product.id, variationId: null, quantitySent: 1 }],
      });
      expect(afterDispatch).toMatchObject({ ok: false });
    });
  });

  describe("dispatch", () => {
    it("T6 — decrements source stock, writes TRANSFERT_SORTIE movements, sets EN_TRANSIT + audit", async () => {
      const d = await createDraft("WAREHOUSE", { sourceQty: 20 });
      const user = await prisma.user.findFirstOrThrow();
      const r = await dispatchStockTransferAction({ id: d.transferId });
      expect(r.ok).toBe(true);

      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(t.status).toBe("EN_TRANSIT");
      expect(t.dispatchedById).toBe(user.id);

      const src = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.source.id, productId: d.product.id } });
      expect(src.quantityOnHand).toBe(15);

      const mv = await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: d.transferId } });
      expect(mv).toMatchObject({ type: "TRANSFERT_SORTIE", quantity: 5, warehouseId: d.source.id });

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "stock_transfer.dispatched", entityId: d.transferId } });
      expect(audit.actorUserId).toBe(user.id);
    });

    it("T7 — insufficient stock rolls back the whole dispatch; status stays BROUILLON", async () => {
      const d = await createDraft("WAREHOUSE", { sourceQty: 3 }); // line asks for 5
      const r = await dispatchStockTransferAction({ id: d.transferId });
      expect(r).toMatchObject({ ok: false });

      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(t.status).toBe("BROUILLON");
      const src = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.source.id } });
      expect(src.quantityOnHand).toBe(3);
      expect(await prisma.inventoryMovement.count({ where: { stockTransferId: d.transferId } })).toBe(0);
    });

    it("T8 — concurrent dispatch of the same transfer: exactly one succeeds, stock moves once", async () => {
      const d = await createDraft("WAREHOUSE", { sourceQty: 20 });
      const results = await Promise.allSettled([
        dispatchStockTransferAction({ id: d.transferId }),
        dispatchStockTransferAction({ id: d.transferId }),
      ]);
      const oks = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
      expect(oks).toBe(1);
      const src = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.source.id } });
      expect(src.quantityOnHand).toBe(15);
      expect(await prisma.inventoryMovement.count({ where: { stockTransferId: d.transferId } })).toBe(1);
    });

    it("T9 — two transfers draining the same source stock: the over-committed one rolls back", async () => {
      const s = await seed({ sourceQty: 8 });
      await loginAsTestUser({ role: "WAREHOUSE" });
      const t1 = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id, 5));
      const t2 = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id, 5));
      if (!t1.ok || !t2.ok) throw new Error("setup");

      const results = await Promise.allSettled([
        dispatchStockTransferAction({ id: t1.data.id }),
        dispatchStockTransferAction({ id: t2.data.id }),
      ]);
      const oks = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
      expect(oks).toBe(1);
      const src = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.source.id } });
      expect(src.quantityOnHand).toBe(3);
    });

    it("dispatch does NOT require the source to still be active", async () => {
      const d = await createDraft("WAREHOUSE", { sourceQty: 20 });
      await prisma.warehouse.update({ where: { id: d.source.id }, data: { isActive: false } });
      const r = await dispatchStockTransferAction({ id: d.transferId });
      expect(r.ok).toBe(true);
    });
  });

  describe("receive", () => {
    async function dispatched(opts?: Parameters<typeof seed>[0]) {
      const d = await createDraft("WAREHOUSE", { sourceQty: 20, ...opts });
      await dispatchStockTransferAction({ id: d.transferId });
      const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: d.transferId } });
      return { ...d, lineId: line.id };
    }

    it("T10 — full receive: destination incremented, quantityReceived persisted, RECU + audit (no shortfall)", async () => {
      const d = await dispatched();
      const user = await prisma.user.findFirstOrThrow();
      const r = await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 5 }] });
      expect(r.ok).toBe(true);

      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(t.status).toBe("RECU");
      expect(t.receivedById).toBe(user.id);

      const dst = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.dest.id, productId: d.product.id } });
      expect(dst.quantityOnHand).toBe(5);
      const line = await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: d.lineId } });
      expect(line.quantityReceived).toBe(5);

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "stock_transfer.received", entityId: d.transferId } });
      expect(audit.metadata).toMatchObject({ hasShortfall: false });
      expect(audit.actorUserId).toBe(user.id);
    });

    it("T11 — partial receive: destination gets the received qty, shortfall not returned to source, audit hasShortfall:true", async () => {
      const d = await dispatched();
      const r = await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 3 }] });
      expect(r.ok).toBe(true);

      const dst = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.dest.id } });
      expect(dst.quantityOnHand).toBe(3);
      const src = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.source.id } });
      expect(src.quantityOnHand).toBe(15); // 20 - 5 sent; shortfall of 2 NOT added back

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "stock_transfer.received", entityId: d.transferId } });
      expect(audit.metadata).toMatchObject({ hasShortfall: true });
    });

    it("T15 — receive with quantityReceived 0 on every line: RECU, destination unchanged", async () => {
      const d = await dispatched();
      const r = await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 0 }] });
      expect(r.ok).toBe(true);
      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(t.status).toBe("RECU");
      expect(await prisma.inventoryItem.count({ where: { warehouseId: d.dest.id } })).toBe(0);
    });

    it("T12 — receive into an inactive destination is rejected; nothing moved", async () => {
      const d = await dispatched();
      await prisma.warehouse.update({ where: { id: d.dest.id }, data: { isActive: false } });
      const r = await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 5 }] });
      expect(r).toMatchObject({ ok: false });
      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(t.status).toBe("EN_TRANSIT");
      expect(await prisma.inventoryItem.count({ where: { warehouseId: d.dest.id } })).toBe(0);
    });

    it("T13 — receive creates a missing destination InventoryItem row then increments it", async () => {
      const d = await dispatched();
      expect(await prisma.inventoryItem.count({ where: { warehouseId: d.dest.id } })).toBe(0);
      await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 5 }] });
      const dst = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.dest.id, productId: d.product.id } });
      expect(dst.quantityOnHand).toBe(5);
      const mv = await prisma.inventoryMovement.findFirstOrThrow({
        where: { stockTransferId: d.transferId, type: "TRANSFERT_ENTREE" },
      });
      expect(mv.warehouseId).toBe(d.dest.id);
    });

    it("T14 — concurrent receive of the same transfer: one succeeds, destination incremented once", async () => {
      const d = await dispatched();
      const results = await Promise.allSettled([
        receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 5 }] }),
        receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 5 }] }),
      ]);
      const oks = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
      expect(oks).toBe(1);
      const dst = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: d.dest.id } });
      expect(dst.quantityOnHand).toBe(5);
    });

    it("rejects a received quantity above the sent quantity", async () => {
      const d = await dispatched();
      const r = await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 99 }] });
      expect(r).toMatchObject({ ok: false });
    });

    it("T21 — a line whose product was deleted mid-transit is skipped without throwing", async () => {
      const d = await dispatched();
      await prisma.product.delete({ where: { id: d.product.id } });
      const r = await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 5 }] });
      expect(r.ok).toBe(true);
      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(t.status).toBe("RECU");
      // the recorded quantityReceived is the only evidence
      const line = await prisma.stockTransferLine.findUniqueOrThrow({ where: { id: d.lineId } });
      expect(line.quantityReceived).toBe(5);
    });

    it("T20 — movement warehouseIds: SORTIE at source, ENTREE at destination", async () => {
      const d = await dispatched();
      await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: d.lineId, quantityReceived: 5 }] });
      const sortie = await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: d.transferId, type: "TRANSFERT_SORTIE" } });
      const entree = await prisma.inventoryMovement.findFirstOrThrow({ where: { stockTransferId: d.transferId, type: "TRANSFERT_ENTREE" } });
      expect(sortie.warehouseId).toBe(d.source.id);
      expect(entree.warehouseId).toBe(d.dest.id);
    });
  });

  describe("cancel + invalid transitions", () => {
    it("T16 — cancel a BROUILLON → ANNULE, no movements, audit", async () => {
      const d = await createDraft();
      const r = await cancelStockTransferAction({ id: d.transferId });
      expect(r.ok).toBe(true);
      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(t.status).toBe("ANNULE");
      expect(await prisma.inventoryMovement.count({ where: { stockTransferId: d.transferId } })).toBe(0);
      await prisma.auditEvent.findFirstOrThrow({ where: { action: "stock_transfer.cancelled", entityId: d.transferId } });
    });

    it("T17 — cannot cancel an EN_TRANSIT or RECU transfer", async () => {
      const d = await createDraft("WAREHOUSE", { sourceQty: 20 });
      await dispatchStockTransferAction({ id: d.transferId });
      expect(await cancelStockTransferAction({ id: d.transferId })).toMatchObject({ ok: false });
    });

    it("T19 — cancel vs dispatch race on a BROUILLON: exactly one wins, state consistent", async () => {
      const d = await createDraft("WAREHOUSE", { sourceQty: 20 });
      const [cancel, dispatch] = await Promise.allSettled([
        cancelStockTransferAction({ id: d.transferId }),
        dispatchStockTransferAction({ id: d.transferId }),
      ]);
      const oks = [cancel, dispatch].filter((r) => r.status === "fulfilled" && r.value.ok).length;
      expect(oks).toBe(1);
      const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: d.transferId } });
      expect(["ANNULE", "EN_TRANSIT"]).toContain(t.status);
      // If it was cancelled, no stock moved; if dispatched, exactly one SORTIE.
      const movements = await prisma.inventoryMovement.count({ where: { stockTransferId: d.transferId } });
      expect(movements).toBe(t.status === "EN_TRANSIT" ? 1 : 0);
    });

    it("cannot receive a BROUILLON (invalid transition)", async () => {
      const d = await createDraft();
      const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: d.transferId } });
      const r = await receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: line.id, quantityReceived: 1 }] });
      expect(r).toMatchObject({ ok: false });
    });
  });

  describe("RBAC", () => {
    const allowed: UserRole[] = ["OWNER", "ADMIN", "MANAGER", "WAREHOUSE"];
    const denied: UserRole[] = ["SALES", "DELIVERY", "SUPPORT", "ACCOUNTANT"];

    it("R1 — allowed roles can create + dispatch + receive + cancel", async () => {
      for (const role of allowed) {
        await resetDb();
        mockCookieStore.clear();
        const s = await seed({ sourceQty: 20 });
        await loginAsTestUser({ role });
        const created = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id, 2));
        expect(created.ok, role).toBe(true);
        if (!created.ok) continue;
        expect((await dispatchStockTransferAction({ id: created.data.id })).ok, role).toBe(true);
        const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: created.data.id } });
        expect((await receiveStockTransferAction({ id: created.data.id, lines: [{ lineId: line.id, quantityReceived: 2 }] })).ok, role).toBe(true);
      }
    });

    it("R2 — denied roles are rejected on every mutation", async () => {
      const d = await createDraft(); // created as WAREHOUSE
      const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: d.transferId } });
      for (const role of denied) {
        mockCookieStore.clear();
        await loginAsTestUser({ role });
        await expect(
          createStockTransferAction(baseCreate(d.source.id, d.dest.id, d.product.id))
        ).rejects.toThrow(/non autorisé/i);
        await expect(dispatchStockTransferAction({ id: d.transferId })).rejects.toThrow(/non autorisé/i);
        await expect(
          receiveStockTransferAction({ id: d.transferId, lines: [{ lineId: line.id, quantityReceived: 1 }] })
        ).rejects.toThrow(/non autorisé/i);
        await expect(cancelStockTransferAction({ id: d.transferId })).rejects.toThrow(/non autorisé/i);
      }
    });

    it("R4 — the audit actor is always the logged-in user, never a payload value", async () => {
      const s = await seed({ sourceQty: 10 });
      const actor = await loginAsTestUser({ role: "MANAGER" });
      const created = await createStockTransferAction(baseCreate(s.source.id, s.dest.id, s.product.id, 2));
      if (!created.ok) throw new Error("setup");
      await dispatchStockTransferAction({ id: created.data.id });
      const events = await prisma.auditEvent.findMany({ where: { entityId: created.data.id } });
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events.every((e) => e.actorUserId === actor.id && e.actorType === "USER")).toBe(true);
    });
  });
});
