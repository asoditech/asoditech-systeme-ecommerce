import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderDeliveryInfo, type OrderDeliveryShipment } from "@/components/orders/order-delivery-info";
import {
  carrierReference,
  lastTrackingEvent,
  safeTrackingUrl,
  shipmentConnectionLabel,
  splitShipmentsForDisplay,
} from "@/lib/orders/delivery-info";
import {
  exactMatchCandidates,
  exactOrderTrackingPriority,
  exactShipmentTrackingPriority,
  orderNumberFromQuery,
} from "@/lib/orders/search";
import { quickSearchOrderNumber } from "@/lib/queries/order-quick-search";

/** Order page « Informations de livraison » + the pure search pieces — no database. */

function shipment(over: Partial<OrderDeliveryShipment> & { id: string }): OrderDeliveryShipment {
  return {
    status: "EN_TRANSIT",
    providerStatusRaw: null,
    providerName: "OzonExpress",
    providerType: "API",
    trackingNumber: `TRK-${over.id}`,
    trackingUrl: null,
    externalId: `TRK-${over.id}`,
    courierName: null,
    courierPhone: null,
    failedReason: null,
    trackingSyncError: null,
    trackingEvents: null,
    createdAt: new Date("2026-10-01T10:00:00Z"),
    shippedAt: null,
    deliveredAt: null,
    lastSyncedAt: null,
    lastTrackingSyncAt: null,
    cost: "35.00",
    costSource: null,
    costFinalized: false,
    ...over,
  };
}

const ALL = { canViewCosts: true, canOverrideCost: false, canViewDelivery: true };
const day = (d: number) => new Date(`2026-10-${String(d).padStart(2, "0")}T10:00:00Z`);

function render(shipments: OrderDeliveryShipment[], v: Partial<typeof ALL> = {}, extra: { codAmount?: number | null; actions?: string } = {}) {
  return renderToStaticMarkup(
    createElement(OrderDeliveryInfo, {
      shipments,
      currency: "MAD",
      codAmount: extra.codAmount ?? null,
      ...ALL,
      ...v,
      actions: extra.actions ? createElement("button", null, extra.actions) : undefined,
    })
  );
}

describe("splitShipmentsForDisplay — primary shipment (presentation only)", () => {
  it("an in-progress shipment wins over a NEWER returned / cancelled one", () => {
    const active = shipment({ id: "a", status: "EN_ATTENTE", createdAt: day(1) });
    const returned = shipment({ id: "r", status: "RETOURNE", createdAt: day(5) });
    const cancelled = shipment({ id: "c", status: "ANNULE", createdAt: day(6) });
    const { primary, previous } = splitShipmentsForDisplay([returned, active, cancelled]);
    expect(primary?.id).toBe("a");
    expect(previous.map((s) => s.id)).toEqual(["c", "r"]);
  });

  it("no live shipment → the newest not failed / cancelled / returned (e.g. delivered)", () => {
    const delivered = shipment({ id: "d", status: "LIVRE", createdAt: day(2) });
    const failed = shipment({ id: "f", status: "ECHEC", createdAt: day(4) });
    expect(splitShipmentsForDisplay([failed, delivered]).primary?.id).toBe("d");
  });

  it("only closed shipments → the newest one; history keeps every other row, newest first", () => {
    const rows = [
      shipment({ id: "1", status: "ECHEC", createdAt: day(1) }),
      shipment({ id: "3", status: "RETOURNE", createdAt: day(3) }),
      shipment({ id: "2", status: "ANNULE", createdAt: day(2) }),
    ];
    const { primary, previous } = splitShipmentsForDisplay(rows);
    expect(primary?.id).toBe("3");
    expect(previous.map((s) => s.id)).toEqual(["2", "1"]);
  });

  it("two live shipments → the newest; equal dates → deterministic", () => {
    const older = shipment({ id: "o", status: "EN_TRANSIT", createdAt: day(1) });
    const newer = shipment({ id: "n", status: "EN_ATTENTE", createdAt: day(2) });
    expect(splitShipmentsForDisplay([older, newer]).primary?.id).toBe("n");
    const x = shipment({ id: "x", createdAt: day(1) });
    const y = shipment({ id: "y", createdAt: day(1) });
    expect(splitShipmentsForDisplay([x, y]).primary?.id).toBe(splitShipmentsForDisplay([y, x]).primary?.id);
  });

  it("no shipment → no primary, no history", () => {
    expect(splitShipmentsForDisplay([])).toEqual({ primary: null, previous: [] });
  });
});

describe("delivery-info helpers", () => {
  it("safeTrackingUrl accepts only absolute http(s) URLs without credentials", () => {
    expect(safeTrackingUrl("https://track.example.ma/OZ123")).toBe("https://track.example.ma/OZ123");
    expect(safeTrackingUrl("http://carrier.ma/t?n=1")).toBe("http://carrier.ma/t?n=1");
    for (const bad of [null, "", "javascript:alert(1)", "data:text/html,x", "/livraison", "//evil.com", "https://u:p@x.ma/", "ftp://x.ma", "https://x.ma/a b", "not a url"]) {
      expect(safeTrackingUrl(bad), String(bad)).toBeNull();
    }
  });

  it("carrierReference is hidden when it equals the tracking number (any case)", () => {
    expect(carrierReference("OZ123", "OZ123")).toBeNull();
    expect(carrierReference("oz123", "OZ123")).toBeNull();
    expect(carrierReference(null, "OZ123")).toBeNull();
    expect(carrierReference("SHP-9", "OZ123")).toBe("SHP-9");
    expect(carrierReference("SHP-9", null)).toBe("SHP-9");
  });

  it("lastTrackingEvent reads the last stored event, never fabricates one", () => {
    expect(lastTrackingEvent(null)).toBeNull();
    expect(lastTrackingEvent({})).toBeNull();
    expect(lastTrackingEvent([])).toBeNull();
    expect(lastTrackingEvent([{ label: "" }])).toBeNull();
    expect(
      lastTrackingEvent([
        { label: "Ramassé", location: "Rabat", timestamp: "2026-10-01T10:00:00Z" },
        { label: null, rawStatus: "LIVRE", location: "Casablanca", timestamp: null },
      ])
    ).toEqual({ label: "LIVRE", location: "Casablanca", timestamp: null });
  });

  it("shipmentConnectionLabel tells API-connected from manual / internal fleet", () => {
    expect(shipmentConnectionLabel("API", "OZ1")).toBe("Connecté (API)");
    expect(shipmentConnectionLabel("API", null)).toBe("API — non créée chez le transporteur");
    expect(shipmentConnectionLabel("MANUEL", null)).toBe("Manuel");
    expect(shipmentConnectionLabel("FLOTTE_INTERNE", null)).toBe("Flotte interne");
  });
});

describe("OrderDeliveryInfo — rendering and visibility", () => {
  it("explicit empty state when the order has no shipment", () => {
    const html = render([]);
    expect(html).toContain("Aucune expédition associée à cette commande.");
    expect(html).not.toContain("primary-shipment");
  });

  it("COD line uses the amount the page computed", () => {
    expect(render([], {}, { codAmount: 249 })).toContain("À encaisser à la livraison (COD)");
    expect(render([])).not.toContain("COD");
  });

  it("primary shipment first, older ones under « Expéditions précédentes »", () => {
    const html = render([
      shipment({ id: "old", status: "RETOURNE", trackingNumber: "OLD-1", createdAt: day(1) }),
      shipment({ id: "new", status: "EN_TRANSIT", trackingNumber: "NEW-1", createdAt: day(3) }),
    ]);
    expect(html.indexOf("NEW-1")).toBeLessThan(html.indexOf("Expéditions précédentes"));
    expect(html.indexOf("Expéditions précédentes")).toBeLessThan(html.indexOf("OLD-1"));
    expect(render([shipment({ id: "only" })])).not.toContain("Expéditions précédentes");
  });

  it("carrier reference only when it differs from the tracking number", () => {
    expect(render([shipment({ id: "1", trackingNumber: "OZ1", externalId: "OZ1" })])).not.toContain("Réf. transporteur");
    const html = render([shipment({ id: "2", trackingNumber: "OZ2", externalId: "SHP-77" })]);
    expect(html).toContain("Réf. transporteur");
    expect(html).toContain("SHP-77");
  });

  it("tracking number is a link only for a safe URL", () => {
    const linked = render([shipment({ id: "1", trackingNumber: "OZ1", trackingUrl: "https://t.example.ma/OZ1" })]);
    expect(linked).toContain('href="https://t.example.ma/OZ1"');
    expect(linked).toContain('rel="noopener noreferrer"');
    const unsafe = render([shipment({ id: "2", trackingNumber: "OZ2", trackingUrl: "javascript:alert(1)" })]);
    expect(unsafe).toContain("OZ2");
    expect(unsafe).not.toContain("javascript:");
    expect(render([shipment({ id: "3", trackingNumber: "OZ3", trackingUrl: null })])).not.toContain("https://");
  });

  it("delivery costs are hidden without the finance permission", () => {
    const rows = [shipment({ id: "1", cost: "35.00" }), shipment({ id: "2", status: "ANNULE", cost: "20.00", createdAt: day(0 + 1) })];
    const withFinance = render(rows);
    expect(withFinance).toContain("Frais de livraison");
    const without = render(rows, { canViewCosts: false });
    expect(without).not.toContain("Frais de livraison");
    expect(without).not.toMatch(/35[,.]00/);
    expect(without).not.toMatch(/20[,.]00/);
  });

  it("« Voir le suivi », courier, carrier events and sync state need delivery.view", () => {
    const s = shipment({
      id: "s1",
      courierName: "Youssef",
      courierPhone: "0611223344",
      trackingSyncError: "Délai dépassé",
      lastTrackingSyncAt: day(4),
      trackingEvents: [{ label: "En cours de livraison", location: "Rabat", timestamp: "2026-10-04T09:00:00Z" }],
    });
    const viewer = render([s]);
    expect(viewer).toContain('href="/livraison/suivi/s1"');
    expect(viewer).toContain("Youssef");
    expect(viewer).toContain("En cours de livraison");
    expect(viewer).toContain("Dernière synchronisation");
    expect(viewer).toContain("Délai dépassé");

    const orderOnly = render([s], { canViewDelivery: false });
    expect(orderOnly).not.toContain("/livraison/suivi/");
    expect(orderOnly).not.toContain("Voir le suivi");
    expect(orderOnly).not.toContain("Youssef");
    expect(orderOnly).not.toContain("0611223344");
    expect(orderOnly).not.toContain("En cours de livraison");
    expect(orderOnly).not.toContain("Délai dépassé");
    // …while the order-level facts stay visible.
    expect(orderOnly).toContain("TRK-s1");
    expect(orderOnly).toContain("OzonExpress");
  });

  it("dates, raw carrier status and failure reason are shown only when stored", () => {
    const bare = render([shipment({ id: "1" })]);
    expect(bare).toContain("Créée le");
    expect(bare).not.toContain("Expédiée le");
    expect(bare).not.toContain("Livrée le");
    expect(bare).not.toContain("Statut transporteur");
    expect(bare).not.toContain("Motif");
    const full = render([
      shipment({ id: "2", status: "ECHEC", shippedAt: day(2), deliveredAt: day(3), providerStatusRaw: "Refusé", failedReason: "Client absent" }),
    ]);
    for (const text of ["Expédiée le", "Livrée le", "Statut transporteur", "Refusé", "Client absent"]) expect(full).toContain(text);
  });

  it("creation / link actions render only when the page passes them (delivery.manage)", () => {
    expect(render([], {}, { actions: "Lier une expédition" })).toContain("Lier une expédition");
    expect(render([])).not.toContain("<button");
  });
});

describe("search building blocks", () => {
  it("orderNumberFromQuery without legacy prefixes reads only the configured one", () => {
    expect(orderNumberFromQuery("OZ123456", "CMD", { allowLegacyPrefix: false })).toBeNull();
    expect(orderNumberFromQuery("CMD-000140", "CMD", { allowLegacyPrefix: false })).toBe(140);
    expect(orderNumberFromQuery("140", "BL/26", { allowLegacyPrefix: false })).toBe(140);
    // Default behaviour unchanged for the list search.
    expect(orderNumberFromQuery("CMD-000140", "BL/26")).toBe(140);
  });

  it("an all-digit prefix never swallows the leading digits of a bare number", () => {
    expect(orderNumberFromQuery("2615", "26")).toBe(2615);
    expect(orderNumberFromQuery("26", "26")).toBe(26);
    expect(orderNumberFromQuery("26-0015", "26")).toBe(15);
    expect(orderNumberFromQuery("26 15", "26")).toBe(15);
    expect(quickSearchOrderNumber("2615", "26")).toBe(2615);
    expect(quickSearchOrderNumber("26-000015", "26")).toBe(15);
    // Mixed prefixes keep the separator-less form (unchanged behaviour).
    expect(orderNumberFromQuery("bl/26000140", "BL/26")).toBe(140);
  });

  it("quickSearchOrderNumber: configured prefix or « CMD », never phones / tracking-like text / overflow", () => {
    expect(quickSearchOrderNumber("CMD-000140", "CMD")).toBe(140);
    expect(quickSearchOrderNumber("BL/26-000140", "BL/26")).toBe(140);
    expect(quickSearchOrderNumber("CMD-000140", "BL/26")).toBe(140);
    expect(quickSearchOrderNumber("000140", "CMD")).toBe(140);
    for (const q of ["0612345678", "212612345678", "+212 612 34 56 78", "06 12 34 56 78", "OZ123456", "Article 12", "2147483648", "99999999999", "12.5"]) {
      expect(quickSearchOrderNumber(q, "CMD"), q).toBeNull();
    }
  });

  it("exact tracking priority: literal `in` over case variants (no ILIKE wildcards) with a NULL-safe complement", () => {
    expect(exactShipmentTrackingPriority("  ")).toBeNull();
    expect(exactMatchCandidates(" oz1 ")).toEqual(["oz1", "OZ1"]);
    expect(exactMatchCandidates("Oz1")).toEqual(["Oz1", "OZ1", "oz1"]);
    expect(exactMatchCandidates("12345")).toEqual(["12345"]);
    // Wildcards / escape characters stay literal values — never patterns.
    expect(exactMatchCandidates("%_\\")).toEqual(["%_\\"]);
    expect(exactShipmentTrackingPriority(" oz1 ")).toEqual({
      exact: { trackingNumber: { in: ["oz1", "OZ1"] } },
      rest: { OR: [{ trackingNumber: null }, { NOT: { trackingNumber: { in: ["oz1", "OZ1"] } } }] },
    });
    expect(exactOrderTrackingPriority("OZ1")).toEqual({
      exact: { shipments: { some: { trackingNumber: { in: ["OZ1", "oz1"] } } } },
      rest: { shipments: { none: { trackingNumber: { in: ["OZ1", "oz1"] } } } },
    });
  });
});
