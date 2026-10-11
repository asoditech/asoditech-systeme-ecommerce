import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Both P3 scan fields (returns-workspace lot, inspection screen) must use
 * ScanCodeInput — the component that submits the field's own value and
 * adopts text typed before hydration. The real component is wrapped to tag
 * where it renders; the real forms are server-rendered. No database.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  redirect: () => {},
  notFound: () => {},
}));

vi.mock("@/components/returns/scan-code-input", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/returns/scan-code-input")>();
  const React = await import("react");
  return {
    ScanCodeInput: (props: Parameters<typeof real.ScanCodeInput>[0]) =>
      React.createElement(real.ScanCodeInput, { ...props, "data-scan-code-input": "" } as Parameters<typeof real.ScanCodeInput>[0]),
  };
});

const { ReturnsScanLot } = await import("@/components/returns/returns-workspace");
const { ReturnInspectionForm } = await import("@/components/returns/return-inspection-form");

/** The `<input …>` tag carrying this aria-label. */
function inputTag(html: string, label: string): string {
  const tag = html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`no input labelled « ${label} »`);
  return tag;
}

describe("P3 scan fields use ScanCodeInput", () => {
  it("returns workspace — the lot scan field", () => {
    const html = renderToStaticMarkup(createElement(ReturnsScanLot));
    const tag = inputTag(html, "Numéro de suivi ou de commande du colis retourné");
    expect(tag).toContain("data-scan-code-input");
    expect(tag).toContain('value=""');
  });

  it("inspection screen — the article scan field (and only it: quantity fields stay plain inputs)", () => {
    const html = renderToStaticMarkup(
      createElement(ReturnInspectionForm, {
        receptionId: "rec_1",
        lines: [
          { orderItemId: "oi_1", nameSnapshot: "Sac cuir", skuSnapshot: "P3-SAC", productId: "p1", variationId: null, shippedQuantity: 3, alreadyReturned: 0 },
        ],
      })
    );
    expect(inputTag(html, "Code de l&#x27;article inspecté")).toContain("data-scan-code-input");
    expect(inputTag(html, "Revendable — Sac cuir")).not.toContain("data-scan-code-input");
    expect((html.match(/data-scan-code-input/g) ?? []).length).toBe(1);
  });
});
