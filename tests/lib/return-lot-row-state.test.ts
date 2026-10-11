import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lotRowDisplayState } from "@/lib/returns/lot-row-state";
import { parcelState } from "@/lib/queries/return-receiving";
import { ReturnParcelStateBadge } from "@/components/returns/returns-workspace";
import { ScanCodeInput } from "@/components/returns/scan-code-input";
import type { ReceiveParcelResult } from "@/lib/returns/reception";

/**
 * P3 returns workspace — lot-row badge and scan field. No database.
 * (The scan field's pre-hydration behaviour itself was verified in Chrome
 * against the real component; this project has no DOM test environment.)
 */

const eligible = { eligible: true, state: "A_RECEPTIONNER" as const };
const ineligible = { eligible: false, state: "A_RECEPTIONNER" as const };
const fail = (code: Extract<ReceiveParcelResult, { ok: false }>["code"]): ReceiveParcelResult => ({ ok: false, code, error: "x" });

describe("lotRowDisplayState — the lot badge reflects whether reception is allowed", () => {
  it("an ineligible, never-received parcel is « Non éligible », never « À réceptionner »", () => {
    expect(lotRowDisplayState(ineligible)).toBe("NON_ELIGIBLE");
  });

  it("an eligible parcel keeps its stage", () => {
    expect(lotRowDisplayState(eligible)).toBe("A_RECEPTIONNER");
    expect(lotRowDisplayState({ eligible: true, state: "A_INSPECTER" })).toBe("A_INSPECTER");
    expect(lotRowDisplayState({ eligible: true, state: "INSPECTE" })).toBe("INSPECTE");
  });

  it("an earlier reception stays visible even if the carrier status changed since", () => {
    expect(lotRowDisplayState({ eligible: false, state: "A_INSPECTER" })).toBe("A_INSPECTER");
    expect(lotRowDisplayState({ eligible: false, state: "INSPECTE" })).toBe("INSPECTE");
  });

  it("after « Réceptionner le lot » the server's answer wins over the scanned stage", () => {
    expect(lotRowDisplayState(eligible, { ok: true, status: "received", receptionId: "r1" })).toBe("A_INSPECTER");
    expect(
      lotRowDisplayState(eligible, { ok: true, status: "already_pending", receptionId: "r1", receivedAt: new Date() })
    ).toBe("A_INSPECTER");
    expect(lotRowDisplayState(eligible, fail("not_eligible"))).toBe("NON_ELIGIBLE");
    expect(lotRowDisplayState(eligible, fail("already_inspected"))).toBe("INSPECTE");
  });

  it("« nothing remaining » shows « Déjà retourné », or « Inspecté » when inspected here", () => {
    expect(lotRowDisplayState(eligible, fail("nothing_remaining"))).toBe("DEJA_RETOURNE");
    expect(lotRowDisplayState({ eligible: true, state: "INSPECTE" }, fail("nothing_remaining"))).toBe("INSPECTE");
  });

  it("a parcel already returned elsewhere keeps « Déjà retourné » in the lot", () => {
    expect(lotRowDisplayState({ eligible: true, state: "DEJA_RETOURNE" })).toBe("DEJA_RETOURNE");
  });

  it("other refusals keep the scanned stage (nothing new is known about it)", () => {
    for (const code of ["denied", "not_found", "invalid"] as const) {
      expect(lotRowDisplayState(eligible, fail(code)), code).toBe("A_RECEPTIONNER");
    }
  });
});

describe("parcelState — stage from receptions AND authoritative quantities (H1)", () => {
  it("never « À réceptionner » when nothing is left to receive", () => {
    expect(parcelState({ pending: false, inspectedCount: 0, remainingUnits: 0 })).toBe("DEJA_RETOURNE");
    expect(parcelState({ pending: false, inspectedCount: 0, remainingUnits: 2 })).toBe("A_RECEPTIONNER");
  });

  it("receptions decide first: pending → à inspecter, inspected → inspecté (whatever remains)", () => {
    expect(parcelState({ pending: true, inspectedCount: 1, remainingUnits: 0 })).toBe("A_INSPECTER");
    expect(parcelState({ pending: false, inspectedCount: 1, remainingUnits: 0 })).toBe("INSPECTE");
    expect(parcelState({ pending: false, inspectedCount: 1, remainingUnits: 3 })).toBe("INSPECTE");
  });
});

describe("ReturnParcelStateBadge", () => {
  it("renders each display state with its French label", () => {
    const html = (state: Parameters<typeof ReturnParcelStateBadge>[0]["state"]) =>
      renderToStaticMarkup(createElement(ReturnParcelStateBadge, { state }));
    expect(html("NON_ELIGIBLE")).toContain("Non éligible");
    expect(html("A_RECEPTIONNER")).toContain("À réceptionner");
    expect(html("A_INSPECTER")).toContain("Reçu — à inspecter");
    expect(html("INSPECTE")).toContain("Inspecté");
    expect(html("DEJA_RETOURNE")).toContain("Déjà retourné");
  });
});

describe("ScanCodeInput", () => {
  it("server-renders a plain, labelled input carrying the current value", () => {
    const html = renderToStaticMarkup(
      createElement(ScanCodeInput, {
        value: "P3MAIN140",
        onValueChange: () => {},
        onSubmitCode: () => {},
        placeholder: "N° de suivi exact ou n° de commande…",
        "aria-label": "Numéro de suivi ou de commande du colis retourné",
      })
    );
    expect(html).toMatch(/^<input /);
    expect(html).toContain('value="P3MAIN140"');
    expect(html).toContain('aria-label="Numéro de suivi ou de commande du colis retourné"');
  });
});
