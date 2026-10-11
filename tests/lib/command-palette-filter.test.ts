import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The global search palette shows SERVER results that are already matched —
 * some by a field the row doesn't display (customer e-mail, sale barcode,
 * variation SKU). cmdk's own client-side text filter must therefore be OFF,
 * or it would hide them. Static source checks (no DOM in this suite).
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PALETTE = read("src/components/layout/command-palette.tsx");
const COMMAND = read("src/components/ui/command.tsx");

describe("command palette — no client-side filtering of server results", () => {
  it("the palette's dialog disables cmdk filtering", () => {
    expect(PALETTE).toMatch(/<CommandDialog[^>]*shouldFilter=\{false\}/);
  });

  it("CommandDialog forwards shouldFilter to the cmdk root", () => {
    expect(COMMAND).toMatch(/function CommandDialog\(\{[\s\S]*?shouldFilter,[\s\S]*?<Command\s+shouldFilter=\{shouldFilter\}/);
  });

  it("every row has an explicit, unique value (cmdk tracks the highlighted row by it)", () => {
    const items = PALETTE.match(/<CommandItem\b[^>]*>/g) ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item, item).toMatch(/\bvalue=\{/);
  });

  it("renders shipments under « Expéditions »", () => {
    expect(PALETTE).toContain('heading="Expéditions"');
  });

  it("drops an in-flight answer when the dialog closes", () => {
    expect(PALETTE).toMatch(/if \(!open \|\| query\.trim\(\)\.length < 2\) \{\s*gate\.current\.cancel\(\);/);
  });
});
