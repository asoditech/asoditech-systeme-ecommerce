import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrackingTable } from "@/components/tracking/tracking-table";
import { normalizeTrackingStatus } from "@/lib/tracking/status";
import type { TrackingRow } from "@/lib/queries/tracking";

/** « Suivi » table — columns, courier (« Livreur ») and carrier situation, from mock provider rows. */

function row(over: Partial<TrackingRow>): TrackingRow {
  return {
    shipmentId: "s1",
    orderId: "o1",
    orderNumber: 1,
    orderDisplayNumber: null,
    orderExternalNumber: null,
    orderSource: "INTERNE",
    orderLabel: "CMD-000001",
    trackingNumber: "OZE123",
    trackingUrl: null,
    customerName: "Sara Amrani",
    customerPhone: "0612345678",
    city: "Rabat",
    productsSummary: null,
    productLines: [],
    orderTotal: "249.00",
    currency: "MAD",
    localStatus: "EN_TRANSIT",
    normalizedStatus: "IN_TRANSIT",
    providerStatusRaw: null,
    providerName: "OzonExpress",
    providerId: "p1",
    deliveryCost: null,
    returnCost: null,
    failureCost: null,
    costSource: null,
    courierName: null,
    courierPhone: null,
    lastUpdateAt: null,
    lastTrackingSyncAt: null,
    trackingSyncError: null,
    deliveredAt: null,
    latestEvent: null,
    ...over,
  };
}

const render = (rows: TrackingRow[]) => renderToStaticMarkup(createElement(TrackingTable, { rows }));

describe("TrackingTable", () => {
  it("columns in operational priority; no carrier fee; « Produits » last", () => {
    const html = render([row({})]);
    const heads = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Commande", "Client", "Ville", "Montant", "Livreur", "Situation", "Dernier évènement", "Produits"]);
    expect(html).not.toContain("Transporteur");
    expect(html).not.toContain("Frais");
    expect(html).toContain("249,00"); // the order amount is kept
  });

  it("client phone under the name: tel: + WhatsApp when unambiguous", () => {
    const html = render([row({ customerPhone: "0612345678" })]);
    expect(html).toContain('href="tel:0612345678"');
    expect(html).toContain("wa.me/212612345678");
    // An ambiguous number: still callable, no WhatsApp guessed.
    const local = render([row({ customerPhone: "612345" })]);
    expect(local).toContain('href="tel:612345"');
    expect(local).not.toContain("wa.me");
  });

  it("courier name + phone (tel: + WhatsApp) when the carrier provided them; « — » otherwise", () => {
    const withCourier = render([row({ courierName: "Hassan hajjaj", courierPhone: "0693993731" })]);
    expect(withCourier).toContain("Hassan hajjaj");
    expect(withCourier).toContain('href="tel:0693993731"');
    expect(withCourier).toContain("wa.me/212693993731");
    expect(render([row({ courierPhone: "0693993731" })])).toContain("0693993731");
    const none = render([row({ customerPhone: null })]);
    expect(none).toMatch(/<td[^>]*><span class="text-muted-foreground">—<\/span><\/td>/);
  });

  it("« Produits » uses the shared ProductChips", () => {
    const html = render([
      row({
        productLines: [
          { name: "T-shirt", quantity: 1, attributes: { Couleur: "Noir" } },
          { name: "T-shirt", quantity: 1, attributes: { Couleur: "Blanc" } },
          { name: "Casquette", quantity: 2, attributes: null },
        ],
      }),
    ]);
    expect(html).toContain("T-shirt — Noir");
    expect(html).toContain("+1");
  });

  it("situation shows the carrier's own wording, coloured by the normalized status", () => {
    const out = "Mise en distribution";
    const noAnswer = "Pas de réponse + SMS";
    const html = render([
      row({ shipmentId: "a", providerStatusRaw: out, normalizedStatus: normalizeTrackingStatus("EN_TRANSIT", out) }),
      row({ shipmentId: "b", providerStatusRaw: noAnswer, normalizedStatus: normalizeTrackingStatus("EN_TRANSIT", noAnswer) }),
      row({ shipmentId: "c", providerStatusRaw: null, normalizedStatus: "DELIVERED", localStatus: "LIVRE" }),
    ]);
    expect(normalizeTrackingStatus("EN_TRANSIT", out)).toBe("OUT_FOR_DELIVERY");
    expect(html).toContain(`title="En cours de livraison">${out}</span>`);
    expect(html).toContain("Pas de réponse + SMS");
    expect(html).toContain(">Livré</span>"); // no raw text → normalized label
  });

  it("latest event: its own text only when it adds something; date always; sync error kept visible", () => {
    const html = render([
      row({
        shipmentId: "a",
        providerStatusRaw: "Pas de réponse + SMS",
        latestEvent: { label: "Client injoignable, SMS envoyé", location: null, timestamp: "2026-10-05T09:19:00.000Z" },
      }),
      row({ shipmentId: "b", providerStatusRaw: "Mise en distribution", latestEvent: { label: "Mise en distribution", location: null, timestamp: null } }),
      row({ shipmentId: "c", trackingSyncError: "timeout" }),
    ]);
    expect(html).toContain("Client injoignable, SMS envoyé");
    expect(html.match(/Mise en distribution/g)).toHaveLength(1); // not repeated in the event column
    expect(html).toContain("Synchro en échec");
  });
});

describe("Suivi page layout", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(protected)/livraison/suivi/page.tsx"), "utf8");
  it("no secondary heading / explanatory subtitle; table fills the viewport and scrolls inside", () => {
    expect(src).not.toContain("Suivi des expéditions\"");
    expect(src).not.toContain("Vue centralisée");
    expect(src).not.toContain("PageHeader");
    expect(src).toContain("max-h-[max(18rem,calc(100dvh-19rem))]");
    expect(src).toContain("<TrackingTable");
    expect(src).toContain("<DataTablePagination");
    expect(src).toContain("RefreshTrackingButton");
  });
});
