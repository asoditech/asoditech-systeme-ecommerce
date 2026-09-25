import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cityGuidanceFromProviders, cityGuidanceMessage } from "@/lib/integrations/delivery/city-guidance";

/**
 * Group 2 (post-audit UX fixes): the order form's/dialog's "write the city
 * exactly as the carrier has it" warning must never hard-code a provider
 * name — it must reflect whichever provider (if any) the tenant actually
 * has active, using the existing `FETCH_CITIES` capability, not a new
 * detection system.
 */
describe("cityGuidanceFromProviders", () => {
  it("Case A — a single active provider that requires an exact catalogue match (e.g. OzonExpress) is named, tone=exact", () => {
    const g = cityGuidanceFromProviders([{ name: "OzonExpress (Maroc)", capabilities: ["CREATE_SHIPMENT", "FETCH_CITIES"] }]);
    expect(g).toEqual({ tone: "exact", providerName: "OzonExpress (Maroc)" });
    expect(cityGuidanceMessage(g)).toContain("OzonExpress (Maroc)");
    expect(cityGuidanceMessage(g)).not.toMatch(/transporteur sélectionné/);
  });

  it("Case A works identically for ANY provider that declares FETCH_CITIES — not hard-coded to OzonExpress by name", () => {
    const g = cityGuidanceFromProviders([{ name: "Une Autre Société", capabilities: ["FETCH_CITIES"] }]);
    expect(g).toEqual({ tone: "exact", providerName: "Une Autre Société" });
    expect(cityGuidanceMessage(g)).toContain("Une Autre Société");
    expect(cityGuidanceMessage(g)).not.toContain("OzonExpress");
  });

  it("Case B — a single active provider without FETCH_CITIES (e.g. Aramex) is named, tone=generic, and no exact-match claim is made", () => {
    const g = cityGuidanceFromProviders([{ name: "Aramex", capabilities: ["CREATE_SHIPMENT", "FETCH_STATUS", "FETCH_TRACKING", "FETCH_COST"] }]);
    expect(g).toEqual({ tone: "generic", providerName: "Aramex" });
    const msg = cityGuidanceMessage(g);
    expect(msg).toContain("Aramex");
    expect(msg).not.toContain("OzonExpress");
    expect(msg).not.toMatch(/exactement comme il apparaît chez/);
  });

  it("Case C — no active provider at all: fully generic wording, no provider name", () => {
    const g = cityGuidanceFromProviders([]);
    expect(g).toEqual({ tone: "none" });
    const msg = cityGuidanceMessage(g);
    expect(msg).not.toContain("OzonExpress");
    expect(msg).not.toContain("Aramex");
    expect(msg).toMatch(/transporteur sélectionné/);
  });

  it("several active providers at once, none exclusively FETCH_CITIES-capable: stays generic and unnamed rather than guessing", () => {
    const g = cityGuidanceFromProviders([
      { name: "Aramex", capabilities: ["FETCH_STATUS"] },
      { name: "Livreur interne", capabilities: [] },
    ]);
    expect(g).toEqual({ tone: "generic", providerName: null });
    expect(cityGuidanceMessage(g)).toMatch(/transporteur sélectionné/);
  });

  it("several active providers, one of them FETCH_CITIES-capable: still exact, naming only that one", () => {
    const g = cityGuidanceFromProviders([
      { name: "Aramex", capabilities: ["FETCH_STATUS"] },
      { name: "OzonExpress (Maroc)", capabilities: ["FETCH_CITIES"] },
    ]);
    expect(g).toEqual({ tone: "exact", providerName: "OzonExpress (Maroc)" });
  });

  it("a MANUEL/FLOTTE_INTERNE provider (no capabilities at all) never triggers the exact-match tone", () => {
    const g = cityGuidanceFromProviders([{ name: "Livreur interne", capabilities: [] }]);
    expect(g).toEqual({ tone: "generic", providerName: "Livreur interne" });
  });
});

describe("no hard-coded provider name left in the generic order UI", () => {
  const root = path.resolve(__dirname, "../..");
  const affected = [
    "src/components/orders/order-form.tsx",
    "src/components/orders/edit-shipping-address-dialog.tsx",
  ];

  it.each(affected)("%s no longer mentions OzonExpress literally", (file) => {
    const source = readFileSync(path.join(root, file), "utf8");
    expect(source).not.toContain("OzonExpress");
  });
});
