import { describe, expect, it } from "vitest";
import { applyReturnScan, type ReturnScanLine } from "@/lib/returns/scan";

/** Return dialogs' scan → +1 revendable on the right line (pure; src/lib/returns/scan.ts). */

const line = (over: Partial<ReturnScanLine>): ReturnScanLine => ({
  id: "l1",
  label: "Casquette",
  productId: "p-cap",
  variationId: null,
  remaining: 2,
  sellable: 0,
  damaged: 0,
  ...over,
});

const lines: ReturnScanLine[] = [
  line({ id: "cap", label: "Casquette", productId: "p-cap", remaining: 2 }),
  line({ id: "noir", label: "T-shirt — Noir", productId: "p-ts", variationId: "v-noir", remaining: 1 }),
  line({ id: "blanc", label: "T-shirt — Blanc", productId: "p-ts", variationId: "v-blanc", remaining: 0 }), // fully returned
];

describe("applyReturnScan", () => {
  it("simple product → its line, +1 revendable", () => {
    expect(applyReturnScan(lines, { productId: "p-cap", variationId: null, label: "Casquette" }, "commande")).toEqual({
      ok: true,
      lineId: "cap",
      label: "Casquette",
      sellable: 1,
    });
  });

  it("variation → exactly its own variation line, never another one of the same product", () => {
    expect(applyReturnScan(lines, { productId: "p-ts", variationId: "v-noir", label: "T-shirt — Noir" }, "commande")).toMatchObject({
      ok: true,
      lineId: "noir",
    });
    const rouge = applyReturnScan(lines, { productId: "p-ts", variationId: "v-rouge", label: "T-shirt — Rouge" }, "commande");
    expect(rouge).toEqual({
      ok: false,
      error: "Cette variante (« T-shirt — Rouge ») ne fait pas partie de cette commande — vérifiez la taille / la couleur.",
    });
  });

  it("a product absent from the order / sale is rejected", () => {
    expect(applyReturnScan(lines, { productId: "p-other", variationId: null, label: "Gourde" }, "vente")).toEqual({
      ok: false,
      error: "« Gourde » ne fait pas partie de cette vente.",
    });
    // A variable product's PARENT never matches a simple-product line.
    expect(applyReturnScan(lines, { productId: "p-ts", variationId: null, label: "T-shirt" }, "commande").ok).toBe(false);
  });

  it("a fully returned line is rejected", () => {
    expect(applyReturnScan(lines, { productId: "p-ts", variationId: "v-blanc", label: "T-shirt — Blanc" }, "commande")).toEqual({
      ok: false,
      error: "« T-shirt — Blanc » a déjà été entièrement retourné.",
    });
  });

  it("repeated scans stop at the remaining quantity — counting units already typed as damaged", () => {
    let current = lines.map((l) => ({ ...l }));
    const scanCap = () => applyReturnScan(current, { productId: "p-cap", variationId: null, label: "Casquette" }, "commande");
    const r1 = scanCap();
    expect(r1).toMatchObject({ ok: true, sellable: 1 });
    current = current.map((l) => (l.id === "cap" ? { ...l, sellable: 1 } : l));
    expect(scanCap()).toMatchObject({ ok: true, sellable: 2 });
    current = current.map((l) => (l.id === "cap" ? { ...l, sellable: 2 } : l));
    expect(scanCap()).toEqual({ ok: false, error: "« Casquette » : quantité maximale à retourner atteinte (2)." });

    // 1 already typed as « endommagé » by hand: only 1 more revendable fits, damaged is never changed.
    const typed = lines.map((l) => (l.id === "cap" ? { ...l, damaged: 1 } : l));
    expect(applyReturnScan(typed, { productId: "p-cap", variationId: null, label: "Casquette" }, "commande")).toMatchObject({ ok: true, sellable: 1 });
    const full = lines.map((l) => (l.id === "cap" ? { ...l, sellable: 1, damaged: 1 } : l));
    expect(applyReturnScan(full, { productId: "p-cap", variationId: null, label: "Casquette" }, "commande").ok).toBe(false);
  });

  it("the same unit on two lines: fills the next line with room", () => {
    const two = [line({ id: "a", remaining: 1, sellable: 1 }), line({ id: "b", remaining: 1 })];
    expect(applyReturnScan(two, { productId: "p-cap", variationId: null, label: "Casquette" }, "commande")).toMatchObject({ ok: true, lineId: "b", sellable: 1 });
  });
});

describe("ReturnScanField — UI contract", () => {
  it("shows the code field, « Ajouter » and the shared camera button « Scanner »; no camera before a click", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ReturnScanField } = await import("@/components/returns/return-scan-field");
    const html = renderToStaticMarkup(createElement(ReturnScanField, { scope: "order", onUnit: () => ({ ok: false as const, error: "x" }) }));
    expect(html).toContain('aria-label="Code de l&#x27;article retourné"');
    expect(html).toContain("Ajouter");
    expect(html).toContain("Scanner");
    expect(html).not.toContain("<video");
  });
});
