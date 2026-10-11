import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CARRIER_UNCERTAIN_RETRY_WARNING,
  bulkShipmentSummary,
  createConfirmGate,
  shipmentCodAmount,
} from "@/lib/shipment-confirmation";
import { ShipmentConfirmationSummary } from "@/components/delivery/shipment-confirmation-summary";

/**
 * P1 — confirmation before a carrier shipment is created. The gate is the
 * only path from the dialogs to the server action (asserted on the sources
 * below), so "cancel ⇒ no submit" and "one confirm ⇒ one submit" here mean
 * "cancel ⇒ no carrier call" and "a double click submits once".
 */

describe("createConfirmGate", () => {
  it("cancel drops the staged submission — the submit callback (carrier call) never runs", () => {
    const gate = createConfirmGate<string>();
    const submit = vi.fn();
    gate.request("order-1");
    expect(gate.hasPending()).toBe(true);
    gate.cancel();
    expect(gate.confirm(submit)).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("confirm submits exactly once, even on a double click", () => {
    const gate = createConfirmGate<string>();
    const submit = vi.fn();
    gate.request("order-1");
    expect(gate.confirm(submit)).toBe(true);
    expect(gate.confirm(submit)).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("order-1");
  });

  it("nothing is submitted without a staged request, and a new request replaces the old one", () => {
    const gate = createConfirmGate<string>();
    const submit = vi.fn();
    expect(gate.confirm(submit)).toBe(false);
    gate.request("first");
    gate.request("second");
    gate.confirm(submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("second");
  });
});

describe("summaries", () => {
  it("COD amount follows the server rule: only cash-on-delivery orders collect money", () => {
    expect(shipmentCodAmount("PAIEMENT_LIVRAISON", "249.50")).toBe(249.5);
    expect(shipmentCodAmount("VIREMENT_BANCAIRE", "249.50")).toBeNull();
    expect(shipmentCodAmount("PAIEMENT_LIVRAISON", "abc")).toBeNull();
  });

  it("bulk summary: carrier, shipment count and total COD (prepaid orders add nothing)", () => {
    const s = bulkShipmentSummary("OzonExpress", [
      { codAmount: 100.1, currency: "MAD" },
      { codAmount: null, currency: "MAD" },
      { codAmount: 249.9, currency: "MAD" },
    ]);
    expect(s).toEqual({ providerName: "OzonExpress", shipmentCount: 3, codTotals: [{ currency: "MAD", amount: 350 }] });
    expect(bulkShipmentSummary("X", [{ codAmount: null, currency: "MAD" }]).codTotals).toEqual([]);
  });

  it("renders carrier, recipient, city, COD and line count; a prepaid order says so", () => {
    const html = renderToStaticMarkup(
      createElement(ShipmentConfirmationSummary, {
        rows: [
          { label: "Transporteur", value: "OzonExpress" },
          { label: "Destinataire", value: "Sara Amrani" },
          { label: "Ville", value: "Rabat" },
          { label: "Montant à encaisser (COD)", money: { amount: 249, currency: "MAD" } },
          { label: "Lignes de commande", value: "2" },
        ],
      })
    );
    for (const text of ["OzonExpress", "Sara Amrani", "Rabat", "249", "Lignes de commande"]) expect(html).toContain(text);
    const prepaid = renderToStaticMarkup(
      createElement(ShipmentConfirmationSummary, { rows: [{ label: "COD", money: { amount: null, currency: "MAD" } }] })
    );
    expect(prepaid).toContain("Aucun (commande prépayée)");
  });

  it("the retry warning tells the operator to check the carrier portal, without promising idempotency", () => {
    expect(CARRIER_UNCERTAIN_RETRY_WARNING).toMatch(/portail/);
    expect(CARRIER_UNCERTAIN_RETRY_WARNING).toMatch(/Lier un colis existant/);
  });
});

describe("dialog wiring (source) — no carrier action is reachable without the confirmation", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("single « Créer une expédition »: an API submit is intercepted and staged; the action runs only from confirmCreation", () => {
    const src = read("src/components/delivery/create-shipment-dialog.tsx");
    expect(src).toMatch(/onSubmit=\{handleSubmit\}/);
    expect(src).toMatch(/if \(!isApiProvider\) return;[\s\S]*event\.preventDefault\(\);[\s\S]*gate\.request\(/);
    expect(src).toMatch(/function confirmCreation\(\) \{[\s\S]*gate\.confirm\(\(formData\) => startTransition\(\(\) => formAction\(formData\)\)\)/);
    expect(src).toMatch(/onClick=\{cancelCreation\}/);
    expect(src).toContain("AlertDialog");
  });

  it("bulk « Créer les expéditions »: the button only stages; runBulk is reached through the gate", () => {
    const src = read("src/components/delivery/awaiting-shipment-table.tsx");
    expect(src).toMatch(/onClick=\{requestBulk\}/);
    expect(src).not.toMatch(/onClick=\{runBulk\}/);
    expect(src).toMatch(/gate\.confirm\(\(payload\) => void runBulk\(payload\.orderIds, payload\.providerId\)\)/);
    expect(src).toMatch(/onClick=\{cancelBulk\}/);
    // The server action is called from runBulk only.
    expect(src.match(/createShipmentsBulkAction\(/g)?.length).toBe(1);
  });
});
