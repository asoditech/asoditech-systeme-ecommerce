import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildTransferLinesPayload,
  canEnterTransferCost,
  parseTransferCostInput,
  TRANSFER_COST_LABEL,
  TRANSFER_COST_NOTE,
} from "@/lib/transfer-cost-ui";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, back: () => {} }),
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { TransferForm } = await import("@/components/transfers/transfer-form");
const { TransferReceiveForm } = await import("@/components/transfers/transfer-receive-form");
const { TransferCostOverrideForm } = await import("@/components/settings/sales-delivery-settings");

/** Transfer purchase-cost UI — the form rules and what each screen renders. */

const editTransfer = {
  id: "t1",
  sourceWarehouseId: "w1",
  sourceName: "Stock général",
  destinationWarehouseId: "w2",
  destinationName: "Magasin Casablanca",
  notes: "",
  lines: [
    { productId: "p1", variationId: null, label: "Polo Bleu L", sku: "POLO-L", quantitySent: 20, destinationUnitCost: "110", globalCost: "100" },
  ],
};
const warehouses = [
  { id: "w1", name: "Stock général", type: "ENTREPOT" as const },
  { id: "w2", name: "Magasin Casablanca", type: "MAGASIN" as const },
];

describe("who may enter a destination cost", () => {
  it("only with the tenant setting on AND finance.view", () => {
    expect(canEnterTransferCost(true, true)).toBe(true);
    expect(canEnterTransferCost(false, true)).toBe(false);
    expect(canEnterTransferCost(true, false)).toBe(false);
  });
});

describe("cost input", () => {
  it("accepts 100, 0, decimals with a dot or a comma; empty means no cost", () => {
    expect(parseTransferCostInput("100")).toEqual({ ok: true, value: 100 });
    expect(parseTransferCostInput("0")).toEqual({ ok: true, value: 0 });
    expect(parseTransferCostInput("110,5")).toEqual({ ok: true, value: 110.5 });
    expect(parseTransferCostInput(" 110.25 ")).toEqual({ ok: true, value: 110.25 });
    expect(parseTransferCostInput("")).toEqual({ ok: true, value: null });
  });

  it("rejects negatives, text, and more than 2 decimals (never silently rounded)", () => {
    for (const bad of ["-1", "abc", "1.234", "1e3", "12345678901"]) expect(parseTransferCostInput(bad).ok).toBe(false);
  });
});

describe("payload sent to the server", () => {
  const lines = [{ productId: "p1", variationId: null, quantitySent: 2, cost: "110" }];

  it("field hidden → no cost key at all (a recorded cost is kept on edit)", () => {
    const r = buildTransferLinesPayload(lines, false);
    expect(r).toEqual({ ok: true, lines: [{ productId: "p1", variationId: null, quantitySent: 2 }] });
    expect(r.ok && "destinationUnitCost" in r.lines[0]).toBe(false);
  });

  it("field shown → the number, 0, or null to clear", () => {
    expect(buildTransferLinesPayload(lines, true)).toMatchObject({ ok: true, lines: [{ destinationUnitCost: 110 }] });
    expect(buildTransferLinesPayload([{ ...lines[0], cost: "0" }], true)).toMatchObject({ ok: true, lines: [{ destinationUnitCost: 0 }] });
    expect(buildTransferLinesPayload([{ ...lines[0], cost: "" }], true)).toMatchObject({ ok: true, lines: [{ destinationUnitCost: null }] });
  });

  it("an invalid cost blocks the submit with a clear message", () => {
    expect(buildTransferLinesPayload([{ ...lines[0], cost: "-5" }], true)).toMatchObject({ ok: false });
  });

  it("a variation line never sends its parent productId", () => {
    const r = buildTransferLinesPayload([{ productId: "p1", variationId: "v1", quantitySent: 1, cost: "" }], true);
    expect(r).toMatchObject({ ok: true, lines: [{ productId: null, variationId: "v1" }] });
  });
});

describe("transfer form", () => {
  it("setting ON (costEntry): shows the destination cost column, the recorded value, the global cost and the note", () => {
    const html = renderToStaticMarkup(createElement(TransferForm, { warehouses, mode: "edit", transfer: editTransfer, costEntry: true }));
    expect(html).toContain(TRANSFER_COST_LABEL.replace("'", "&#x27;"));
    expect(html).toContain('value="110"');
    expect(html).toMatch(/Coût global : 100,00/);
    expect(html).toContain(TRANSFER_COST_NOTE.replace(/'/g, "&#x27;"));
  });

  it("setting OFF / no finance.view: no cost field, no cost value in the page", () => {
    const html = renderToStaticMarkup(createElement(TransferForm, { warehouses, mode: "edit", transfer: editTransfer }));
    expect(html).not.toContain("Coût d&#x27;achat à destination");
    expect(html).not.toContain("Coût global");
    expect(html).not.toContain('value="110"');
  });
});

describe("receive dialog", () => {
  const base = { id: "l1", label: "Polo Bleu L", sku: "POLO-L", quantitySent: 20 };

  it("displays the recorded destination cost when one is passed", () => {
    const html = renderToStaticMarkup(createElement(TransferReceiveForm, { transferId: "t1", lines: [{ ...base, destinationCost: "110" }] }));
    expect(html).toContain("Coût d&#x27;achat à destination");
    expect(html).toMatch(/110,00/);
  });

  it("a recorded cost of 0 is displayed as 0, not hidden", () => {
    const html = renderToStaticMarkup(createElement(TransferReceiveForm, { transferId: "t1", lines: [{ ...base, destinationCost: "0" }] }));
    expect(html).toMatch(/0,00/);
  });

  it("no cost (or no finance.view) → no cost column", () => {
    const html = renderToStaticMarkup(createElement(TransferReceiveForm, { transferId: "t1", lines: [base] }));
    expect(html).not.toContain("Coût d&#x27;achat à destination");
  });
});

describe("configuration toggle", () => {
  it("renders the setting as a switch with its explanation and current state", () => {
    const state = (html: string) => html.match(/role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="Coût d&#x27;achat lors des transferts"/)?.[1];
    const off = renderToStaticMarkup(createElement(TransferCostOverrideForm, { enabled: false }));
    expect(off).toContain("Coût d&#x27;achat lors des transferts");
    expect(state(off)).toBe("false");
    expect(off).toContain("Désactivé");
    expect(off).toContain("Le prix de vente n&#x27;est jamais modifié");
    expect(off).toContain("Réservé aux utilisateurs ayant accès aux données financières");
    const on = renderToStaticMarkup(createElement(TransferCostOverrideForm, { enabled: true }));
    expect(state(on)).toBe("true");
    expect(on).toContain("Activé");
  });
});
