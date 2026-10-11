import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P2 audit follow-up — the order form must never display stock from a
 * warehouse the user already left. There is no DOM test harness in this
 * project, so these are SOURCE checks pinning the guard (not a browser test).
 */
const src = readFileSync(join(process.cwd(), "src/components/orders/order-form.tsx"), "utf8");

describe("order form — stale stock responses are ignored", () => {
  it("tracks the currently selected stock warehouse synchronously and sequences line-stock requests", () => {
    expect(src).toMatch(/const currentStockWarehouse = React\.useRef<string \| null>\(stockWarehouseId\)/);
    expect(src).toMatch(/currentStockWarehouse\.current = nextStockWarehouseId;\s*const seq = \+\+lineStockRequest\.current;/);
  });

  it("line stock: only the latest request for the current warehouse is applied, merged, never wholesale replaced", () => {
    expect(src).toMatch(/const isLatest = \(\) => seq === lineStockRequest\.current && currentStockWarehouse\.current === nextStockWarehouseId;/);
    expect(src).toMatch(/if \(isLatest\(\)\) setLineStock\(\(prev\) => \(\{ \.\.\.prev, \.\.\.fresh \}\)\)/);
    expect(src).not.toMatch(/\.then\(setLineStock\)/);
  });

  it("product search and the initial list ignore answers for another warehouse", () => {
    expect(src).toMatch(/if \(cancelled \|\| currentStockWarehouse\.current !== stockWarehouseId\) return;/);
    expect(src).toMatch(/if \(currentStockWarehouse\.current === requestedFor\) setInitialProducts\(list\);/);
  });
});
