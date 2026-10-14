import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Roadmap List 1 · A2 — « Entrepôt de préparation » first (acceptance:
 * docs/RELEASE-VERIFICATION-CHECKLIST.md §7 A2: step 1 above Client, changing
 * it refreshes line stock, no second selector below). Browser pass recorded
 * 2026-10-12; this is the dedicated regression test the roadmap still lacked.
 * No DOM test harness exists in this project, so these are SOURCE checks
 * (like tests/lib/order-form-stock-guard.test.ts) — not a browser test.
 */
const src = readFileSync(join(process.cwd(), "src/components/orders/order-form.tsx"), "utf8");
const jsx = src.slice(src.indexOf("return ("));

describe("order form — preparation warehouse is chosen first (A2)", () => {
  it("the warehouse card is rendered before the Client card, as step 1", () => {
    const warehouseCard = jsx.indexOf("Entrepôt de préparation");
    const clientCard = jsx.search(/\n\s*Client\n/);
    expect(warehouseCard).toBeGreaterThan(-1);
    expect(clientCard).toBeGreaterThan(-1);
    expect(warehouseCard).toBeLessThan(clientCard);
    expect(jsx.slice(Math.max(0, warehouseCard - 400), warehouseCard)).toMatch(/>1<\/span>/);
  });

  it("only shown when there is a real choice (≥ 2 warehouses)", () => {
    expect(jsx).toMatch(/\{warehouses\.length > 1 && \(\s*<Card>[\s\S]{0,400}Entrepôt de préparation/);
  });

  it("exactly one preparation-warehouse selector — no second selector further down", () => {
    expect(src.match(/id="ord-warehouse"/g)).toHaveLength(1);
    expect(src.match(/onValueChange=\{\(v\) => v && changeFulfillmentWarehouse\(v\)\}/g)).toHaveLength(1);
    expect(src.match(/setFulfillmentWarehouseId\(/g)).toHaveLength(1); // only through changeFulfillmentWarehouse
  });

  it("changing it refreshes the stock of the lines already added (and the product list for the new warehouse)", () => {
    const fn = src.slice(src.indexOf("function changeFulfillmentWarehouse"), src.indexOf("function changeFulfillmentWarehouse") + 1500);
    expect(fn).toMatch(/setFulfillmentWarehouseId\(id\)/);
    expect(fn).toMatch(/setInitialProducts\(null\)/);
    expect(fn).toMatch(/getOrderLinesStockAction\(nextStockWarehouseId, requested\)/);
  });

  it("the order is submitted with the chosen preparation warehouse (when several exist)", () => {
    expect(src).toMatch(/fulfillmentWarehouseId: warehouses\.length > 1 && fulfillmentWarehouseId \? fulfillmentWarehouseId : null/);
  });
});
