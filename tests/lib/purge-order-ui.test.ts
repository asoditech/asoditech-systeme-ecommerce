import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PurgeEvaluation } from "@/lib/orders/purge";
import { purgeConfirmationReady, purgeOutcome, shouldOfferPurge } from "@/lib/orders/purge-ui";
import { cn } from "@/lib/utils";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const {
  PurgeOrderButton,
  PurgeOrderPanel,
  PurgeDialogBody,
  PURGE_DIALOG_CONTENT_CLASS,
  PURGE_DIALOG_BODY_CLASS,
  PURGE_DIALOG_FOOTER_CLASS,
} = await import("@/components/orders/purge-order-dialog");

/** « Purger cette commande de test » — the UI rules and the dialog body. */

const summary = {
  orderId: "o1",
  orderLabel: "CMD-000042",
  statusLabel: "Emballage",
  customerName: "Sara Amrani",
  total: "250,00 MAD",
  lines: [
    { name: "T-shirt — Noir", sku: "TS-NOIR", quantity: 1 },
    { name: "Casquette", sku: "CAP-1", quantity: 2 },
  ],
};
const eligible: PurgeEvaluation = {
  eligible: true,
  preview: {
    releaseReservation: true,
    releasedLines: [
      { name: "T-shirt — Noir", sku: "TS-NOIR", quantity: 1 },
      { name: "Casquette", sku: "CAP-1", quantity: 2 },
    ],
    failedShipmentIds: ["s1"],
  },
};
const refused: PurgeEvaluation = {
  eligible: false,
  reasons: ["Un colis existe chez le transporteur (OZE-1) : annulez-le dans le portail du transporteur ; la commande peut seulement être annulée."],
};

const panel = (over: Partial<Parameters<typeof PurgeOrderPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(PurgeOrderPanel, { summary, evaluation: eligible, reason: "", typedNumber: "", error: null, ...over }));

describe("when the action is offered", () => {
  it("only with orders.purge AND an eligible server preview", () => {
    expect(shouldOfferPurge(true, { ok: true, data: eligible })).toBe(true);
    expect(shouldOfferPurge(true, { ok: true, data: refused })).toBe(false); // ineligible order
    expect(shouldOfferPurge(false, { ok: true, data: eligible })).toBe(false); // permission denied
    expect(shouldOfferPurge(true, { ok: false })).toBe(false);
    expect(shouldOfferPurge(true, null)).toBe(false);
  });

  it("the trigger is its own, visibly destructive outline action — not « Annuler »", () => {
    const html = renderToStaticMarkup(createElement(PurgeOrderButton, { summary, initialEvaluation: eligible }));
    expect(html).toContain("Purger cette commande de test");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("Annuler la commande");
    expect(html).not.toContain("Purger définitivement"); // dialog closed
  });
});

describe("two deliberate confirmations", () => {
  const ready = (reason: string, typedNumber: string, isEligible = true) =>
    purgeConfirmationReady({ reason, typedNumber, orderLabel: "CMD-000042", eligible: isEligible });
  it("a reason is required (3+ characters)", () => {
    expect(ready("", "CMD-000042")).toBe(false);
    expect(ready("  ab ", "CMD-000042")).toBe(false);
    expect(ready("Test boutique", "CMD-000042")).toBe(true);
  });
  it("the exact order number is required", () => {
    expect(ready("Test", "")).toBe(false);
    expect(ready("Test", "CMD-00004")).toBe(false);
    expect(ready("Test", "cmd-000042")).toBe(false); // exact, not case-insensitive
    expect(ready("Test", "42")).toBe(false);
    expect(ready("Test", " CMD-000042 ")).toBe(true); // surrounding spaces ignored
  });
  it("never enabled for an ineligible order", () => {
    expect(ready("Test", "CMD-000042", false)).toBe(false);
  });
});

describe("dialog body", () => {
  it("eligible: order, status, customer, total, products, released reservation, failed attempts and the three notices", () => {
    const html = panel();
    for (const text of ["CMD-000042", "Emballage", "Sara Amrani", "250,00 MAD", "T-shirt — Noir", "TS-NOIR", "×2"]) expect(html, text).toContain(text);
    expect(html).toContain("Stock réservé libéré");
    expect(html).toContain("T-shirt — Noir ×1, Casquette ×2");
    expect(html).toContain("Tentatives d&#x27;expédition en échec supprimées");
    expect(html).toContain("mouvements de stock et l&#x27;historique (journal d&#x27;audit) sont conservés");
    expect(html).toContain("Le client est conservé");
    expect(html).toContain("supprime définitivement la commande");
    expect(html).toContain("Motif (obligatoire)");
    expect(html).toMatch(/Tapez <span[^>]*>CMD-000042<\/span> pour confirmer/);
  });

  it("nothing reserved: says so instead of a release list", () => {
    const html = panel({ evaluation: { eligible: true, preview: { releaseReservation: false, releasedLines: [], failedShipmentIds: [] } } });
    expect(html).toContain("Aucun stock réservé à libérer");
    expect(html).not.toContain("Tentatives d&#x27;expédition");
  });

  it("ineligible: the server's reasons, inputs disabled", () => {
    const html = panel({ evaluation: refused });
    expect(html).toContain("Cette commande ne peut pas être purgée");
    expect(html).toContain("Un colis existe chez le transporteur (OZE-1)");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("a server-side refusal is displayed", () => {
    expect(panel({ error: "La commande a déjà été expédiée : le stock a été déduit — utilisez un retour physique." })).toContain(
      "La commande a déjà été expédiée"
    );
  });
});

describe("result handling", () => {
  it("success → message + redirect to the orders list (never stay on the deleted order)", () => {
    expect(purgeOutcome({ ok: true, data: { label: "CMD-000042" } })).toEqual({
      kind: "success",
      message: "Commande CMD-000042 purgée.",
      redirectTo: "/commandes",
    });
  });
  it("refusal → the server's message, no redirect", () => {
    expect(purgeOutcome({ ok: false, error: "Un remboursement est enregistré pour cette commande." })).toEqual({
      kind: "error",
      message: "Un remboursement est enregistré pour cette commande.",
    });
  });
});

describe("short / mobile viewport layout", () => {
  // The shared DialogContent scrolls the whole popup and DialogFooter is a sticky
  // overlay at its bottom — together they let the footer cover the last field.
  const sharedContent = "grid max-h-[calc(100vh-2rem)] overflow-y-auto gap-5 p-6 sm:max-w-md";
  const sharedFooter = "sticky -bottom-6 z-10 -mx-6 -mb-6 flex border-t bg-muted/40 px-6 py-4";

  it("the popup no longer scrolls: a height-capped flex column", () => {
    const merged = cn(sharedContent, PURGE_DIALOG_CONTENT_CLASS).split(" ");
    expect(merged).toEqual(expect.arrayContaining(["flex", "flex-col", "overflow-hidden", "max-h-[92dvh]", "sm:max-w-lg"]));
    expect(merged).not.toContain("overflow-y-auto");
    expect(merged).not.toContain("grid");
  });

  it("the footer stays in the flow below the body, never sticky over it, with the same look", () => {
    const merged = cn(sharedFooter, PURGE_DIALOG_FOOTER_CLASS).split(" ");
    expect(merged).toContain("static");
    expect(merged).toContain("shrink-0");
    expect(merged).not.toContain("sticky");
    // visual design preserved
    expect(merged).toEqual(expect.arrayContaining(["border-t", "bg-muted/40", "-mx-6", "-mb-6"]));
  });

  it("the body scrolls on its own and holds both confirmation fields", () => {
    expect(PURGE_DIALOG_BODY_CLASS.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "overflow-y-auto"]));
    const html = renderToStaticMarkup(
      createElement(PurgeDialogBody, null, createElement(PurgeOrderPanel, { summary, evaluation: eligible, reason: "", typedNumber: "", error: null }))
    );
    const bodyOpen = html.indexOf('data-slot="purge-dialog-body"');
    expect(bodyOpen).toBe(html.indexOf("<div") + "<div ".length);
    expect(html.indexOf('id="purge-reason"')).toBeGreaterThan(bodyOpen);
    expect(html.indexOf('id="purge-confirm-number"')).toBeGreaterThan(bodyOpen);
    expect(html.endsWith("</div></div>")).toBe(true);
  });
});
