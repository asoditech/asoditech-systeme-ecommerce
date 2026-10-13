import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import { getUnitTraceability, movementCostState, referenceCostOf } from "@/lib/queries/traceability";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Traçabilité — the « Coût » column used to show « — » for every movement that
 * does not store its own cost, even when the product has a purchase cost. The
 * history is NEVER back-filled: a movement keeps exactly what it recorded;
 * the unit's CURRENT reference cost (variation → product, + location cost) is
 * shown separately, and an absent cost is said so.
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

async function seed(opts: { productCost: number | null; variationCost?: number | null; withVariation?: boolean; locationCost?: number | null }) {
  const wh = await prisma.warehouse.create({ data: { name: "Entrepôt A", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BASK-1", price: 100, status: "ACTIF", cost: opts.productCost } });
  const variation = opts.withVariation
    ? await prisma.productVariation.create({ data: { productId: product.id, sku: "BASK-1-42", attributes: { Taille: "42" }, cost: opts.variationCost ?? null } })
    : null;
  const item = await prisma.inventoryItem.create({
    data: {
      warehouseId: wh.id,
      ...(variation ? { variationId: variation.id } : { productId: product.id }),
      quantityOnHand: 12,
      currentUnitCost: opts.locationCost ?? null,
    },
  });
  // A reception that recorded what was paid, then an online-order fulfilment that never stores a cost.
  await prisma.inventoryMovement.create({ data: { inventoryItemId: item.id, warehouseId: wh.id, type: "RECEPTION", quantity: 10, onHandDelta: 10, onHandAfter: 10, unitCost: 37.5 } });
  await prisma.inventoryMovement.create({ data: { inventoryItemId: item.id, warehouseId: wh.id, type: "VENTE", quantity: 1, onHandDelta: -1, onHandAfter: 9 } });
  return { wh, product, variation };
}

const traceAs = async (ref: { productId: string; variationId: string | null }) => (await getUnitTraceability((await getCurrentUser())!, ref))!;

describe("traceability cost — recorded per movement, reference cost shown separately", () => {
  it("variant with its own cost: reference = variation cost; the reception keeps its recorded cost; the sale says « not recorded », never invented", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product, variation } = await seed({ productCost: 20, withVariation: true, variationCost: 30 });
    const t = await traceAs({ productId: product.id, variationId: variation!.id });
    expect(t.referenceCost).toEqual({ global: 30, globalSource: "variation", locations: [] });
    expect(t.movements.find((m) => m.type === "RECEPTION")).toMatchObject({ unitCost: 37.5, costState: "recorded" });
    expect(t.movements.find((m) => m.type === "VENTE")).toMatchObject({ unitCost: null, costState: "not_recorded" });
  });

  it("variant without a cost of its own falls back to the PRODUCT cost (labelled as such)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product, variation } = await seed({ productCost: 20, withVariation: true, variationCost: null });
    const t = await traceAs({ productId: product.id, variationId: variation!.id });
    expect(t.referenceCost).toEqual({ global: 20, globalSource: "product", locations: [] });
  });

  it("location cost is listed beside the global cost", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product, wh } = await seed({ productCost: 20, locationCost: 22.5 });
    const t = await traceAs({ productId: product.id, variationId: null });
    expect(t.referenceCost).toEqual({ global: 20, globalSource: "product", locations: [{ warehouseId: wh.id, warehouseName: "Entrepôt A", cost: 22.5 }] });
  });

  it("no cost anywhere: an explicit missing state (null), never 0", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product } = await seed({ productCost: null });
    const t = await traceAs({ productId: product.id, variationId: null });
    expect(t.referenceCost).toEqual({ global: null, globalSource: null, locations: [] });
    expect(t.productHref).toBe(`/produits/${product.id}`);
  });

  it("without finance.view: no reference cost; a reception price stays visible with purchases.view, any other cost is « hidden »", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product } = await seed({ productCost: 20 });
    const viewer = { ...(await getCurrentUser())!, permissions: new Set(["traceability.view", "purchases.view"]) } as never;
    const t = (await getUnitTraceability(viewer, { productId: product.id, variationId: null }))!;
    expect(t.referenceCost).toBeNull();
    expect(t.movements.find((m) => m.type === "RECEPTION")).toMatchObject({ unitCost: 37.5, costState: "recorded" });
  });
});

describe("pure rules", () => {
  it("movementCostState", () => {
    const fin = { cost: true, purchasePrices: false };
    const buyer = { cost: false, purchasePrices: true };
    expect(movementCostState(null, "VENTE", fin)).toEqual({ unitCost: null, costState: "not_recorded" });
    expect(movementCostState("12.5", "VENTE", fin)).toEqual({ unitCost: 12.5, costState: "recorded" });
    expect(movementCostState("12.5", "VENTE", buyer)).toEqual({ unitCost: null, costState: "hidden" });
    expect(movementCostState("12.5", "RECEPTION", buyer)).toEqual({ unitCost: 12.5, costState: "recorded" });
    expect(movementCostState("0", "RECEPTION", fin)).toEqual({ unitCost: 0, costState: "recorded" });
  });

  it("referenceCostOf", () => {
    const wh = { id: "w", name: "W" };
    expect(referenceCostOf({ cost: null }, { cost: null }, [{ warehouse: wh, currentUnitCost: null }])).toEqual({ global: null, globalSource: null, locations: [] });
    expect(referenceCostOf(null, { cost: "9" }, [])).toEqual({ global: 9, globalSource: "product", locations: [] });
    expect(referenceCostOf({ cost: "0" }, { cost: "9" }, [])).toEqual({ global: 0, globalSource: "variation", locations: [] });
  });
});
