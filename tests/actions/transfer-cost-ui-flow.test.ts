import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createStockTransferAction,
  updateStockTransferDraftAction,
  dispatchStockTransferAction,
  receiveStockTransferAction,
  listSourceStockAction,
} from "@/actions/transfers";
import { updateTransferCostOverrideAction } from "@/actions/settings";
import { buildTransferLinesPayload } from "@/lib/transfer-cost-ui";
import { getStockTransferDetail } from "@/lib/queries/transfers";
import { resetDb } from "../helpers/db";
import { loginAsTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Transfer purchase-cost UI — the server side of what the screens do: the
 * Configuration toggle, the form payload (via the same helper the form uses),
 * draft-only editing, finance-only cost data, and the receive display data.
 */

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const fd = (v: string) => {
  const f = new FormData();
  f.set("transferPurchaseCostOverrideEnabled", v);
  return f;
};

async function seed() {
  const general = await prisma.warehouse.create({ data: { name: "Stock général", isDefault: true } });
  const casa = await prisma.warehouse.create({ data: { name: "Magasin Casablanca", type: "MAGASIN" } });
  const product = await prisma.product.create({ data: { name: "Polo Bleu L", sku: `POLO-${Math.random()}`, price: 180, cost: 100, status: "ACTIF" } });
  await prisma.inventoryItem.create({ data: { warehouseId: general.id, productId: product.id, quantityOnHand: 40 } });
  return { general, casa, product };
}

/** Creates a draft exactly as the form would, with `cost` typed in the field (or the field hidden). */
async function createFromForm(s: Awaited<ReturnType<typeof seed>>, cost: string | undefined) {
  const payload = buildTransferLinesPayload([{ productId: s.product.id, variationId: null, quantitySent: 20, cost }], cost !== undefined);
  if (!payload.ok) throw new Error(payload.error);
  return createStockTransferAction({ sourceWarehouseId: s.general.id, destinationWarehouseId: s.casa.id, notes: "", lines: payload.lines });
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("Configuration toggle", () => {
  it("appears off by default and saves; ADMIN (settings.manage + finance.view)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    expect((await prisma.businessSettings.findFirst())?.transferPurchaseCostOverrideEnabled ?? false).toBe(false);
    expect((await updateTransferCostOverrideAction(fd("true"))).ok).toBe(true);
    expect((await prisma.businessSettings.findFirstOrThrow()).transferPurchaseCostOverrideEnabled).toBe(true);
  });

  it("settings.manage without finance.view is refused", async () => {
    const u = await loginAsTestUser({ role: "MANAGER" });
    await prisma.userPermissionOverride.create({ data: { userId: u.id, permission: "settings.manage", effect: "GRANT" } });
    await prisma.userPermissionOverride.create({ data: { userId: u.id, permission: "finance.view", effect: "DENY" } });
    const { getCurrentUser } = await import("@/lib/auth/session");
    const me = (await getCurrentUser())!;
    expect([me.permissions.has("settings.manage"), me.permissions.has("finance.view")]).toEqual([true, false]);
    const r = await updateTransferCostOverrideAction(fd("true"));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/données financières/) });
    expect((await prisma.businessSettings.findFirst())?.transferPurchaseCostOverrideEnabled ?? false).toBe(false);
  });

  it("a role without settings.manage cannot change it", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(updateTransferCostOverrideAction(fd("true"))).rejects.toThrow(/non autorisé/i);
  });
});

describe("form → server", () => {
  it("setting ON: 100 accepted, 0 accepted (0 is a real cost), recorded on the line", async () => {
    await prisma.businessSettings.create({ data: { transferPurchaseCostOverrideEnabled: true } });
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const a = await createFromForm(s, "100");
    const b = await createFromForm(s, "0");
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(num((await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: a.data.id } })).destinationUnitCost)).toBe(100);
    expect(num((await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: b.data.id } })).destinationUnitCost)).toBe(0);
  });

  it("negative is rejected by the server even if the client check is bypassed", async () => {
    await prisma.businessSettings.create({ data: { transferPurchaseCostOverrideEnabled: true } });
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const r = await createStockTransferAction({
      sourceWarehouseId: s.general.id,
      destinationWarehouseId: s.casa.id,
      notes: "",
      lines: [{ productId: s.product.id, variationId: null, quantitySent: 1, destinationUnitCost: -1 }],
    });
    expect(r.ok).toBe(false);
  });

  it("setting OFF: the hidden field sends no cost → transfer works exactly as before", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const r = await createFromForm(s, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: r.data.id } })).destinationUnitCost).toBeNull();
  });

  it("finance.view is required: a direct call from a transfer-only role is refused", async () => {
    await prisma.businessSettings.create({ data: { transferPurchaseCostOverrideEnabled: true } });
    const s = await seed();
    const wh = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(wh.id, [s.general.id, s.casa.id]);
    const r = await createFromForm(s, "110");
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/droit/) });
  });

  it("source stock carries the global cost only for finance.view users", async () => {
    const s = await seed();
    await loginAsTestUser({ role: "ADMIN" });
    expect((await listSourceStockAction(s.general.id))[0].globalCost).toBe("100");
    mockCookieStore.clear();
    const wh = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(wh.id, [s.general.id]);
    expect((await listSourceStockAction(s.general.id))[0].globalCost).toBeNull();
  });
});

describe("draft editing", () => {
  it("BROUILLON: edit replaces, empty field clears, hidden field keeps", async () => {
    await prisma.businessSettings.create({ data: { transferPurchaseCostOverrideEnabled: true } });
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const r = await createFromForm(s, "110");
    if (!r.ok) throw new Error(r.error);
    const edit = async (cost: string | undefined) => {
      const p = buildTransferLinesPayload([{ productId: s.product.id, variationId: null, quantitySent: 20, cost }], cost !== undefined);
      if (!p.ok) throw new Error(p.error);
      return updateStockTransferDraftAction({ id: r.data.id, notes: "", lines: p.lines });
    };
    const cost = async () => num((await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: r.data.id } })).destinationUnitCost);

    expect((await edit("120")).ok).toBe(true);
    expect(await cost()).toBe(120);
    expect((await edit(undefined)).ok).toBe(true); // field hidden (setting off / no finance) → kept
    expect(await cost()).toBe(120);
    expect((await edit("")).ok).toBe(true); // emptied → cleared
    expect(await cost()).toBeNull();
  });

  it("not editable once dispatched (EN_TRANSIT) — the recorded cost stays", async () => {
    await prisma.businessSettings.create({ data: { transferPurchaseCostOverrideEnabled: true } });
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const r = await createFromForm(s, "110");
    if (!r.ok) throw new Error(r.error);
    expect((await dispatchStockTransferAction({ id: r.data.id })).ok).toBe(true);
    const p = buildTransferLinesPayload([{ productId: s.product.id, variationId: null, quantitySent: 20, cost: "999" }], true);
    if (!p.ok) throw new Error(p.error);
    const res = await updateStockTransferDraftAction({ id: r.data.id, notes: "", lines: p.lines });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/brouillon/) });
    expect(num((await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: r.data.id } })).destinationUnitCost)).toBe(110);
  });
});

describe("receive", () => {
  it("the detail query exposes the recorded cost for the receive dialog; it survives the setting being turned OFF and applies on receive", async () => {
    await prisma.businessSettings.create({ data: { transferPurchaseCostOverrideEnabled: true } });
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const r = await createFromForm(s, "110");
    if (!r.ok) throw new Error(r.error);
    await dispatchStockTransferAction({ id: r.data.id });
    expect((await updateTransferCostOverrideAction(fd("false"))).ok).toBe(true);

    const detail = await getStockTransferDetail(r.data.id);
    expect(num(detail?.lines[0].destinationUnitCost)).toBe(110);

    const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: r.data.id } });
    expect((await receiveStockTransferAction({ id: r.data.id, lines: [{ lineId: line.id, quantityReceived: 20 }] })).ok).toBe(true);
    const casaItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.casa.id, productId: s.product.id } });
    expect([casaItem.quantityOnHand, num(casaItem.currentUnitCost)]).toEqual([20, 110]);
  });

  it("a transfer without cost keeps today's behaviour (no location cost, null movement cost)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const s = await seed();
    const r = await createFromForm(s, undefined);
    if (!r.ok) throw new Error(r.error);
    await dispatchStockTransferAction({ id: r.data.id });
    const line = await prisma.stockTransferLine.findFirstOrThrow({ where: { stockTransferId: r.data.id } });
    await receiveStockTransferAction({ id: r.data.id, lines: [{ lineId: line.id, quantityReceived: 20 }] });
    const casaItem = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: s.casa.id, productId: s.product.id } });
    expect(casaItem.currentUnitCost).toBeNull();
    const movements = await prisma.inventoryMovement.findMany({ where: { stockTransferId: r.data.id } });
    expect(movements.every((m) => m.unitCost === null)).toBe(true);
  });
});
