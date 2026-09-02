import { describe, expect, it } from "vitest";
// Importing the production bootstrap runs its top-level adapter
// registrations exactly as it does in a real server process.
import "@/lib/integrations/delivery/providers";
import { listDeliveryProviders } from "@/lib/integrations/delivery/registry";
import { listAvailableDeliveryConnectors } from "@/lib/queries/delivery";

/**
 * Phase 23 continuation: OzonExpress is now wired into the production
 * provider bootstrap, so "Livraison → Prestataires → Configurer" is
 * enabled (the button disables only when zero connectors are registered).
 */
describe("production delivery-provider registry", () => {
  it("registers OzonExpress", () => {
    expect(listDeliveryProviders().map((a) => a.key)).toContain("ozonexpress");
  });

  it("exposes OzonExpress to the UI with typed Customer ID + API Key fields (apiKey masked)", () => {
    const connector = listAvailableDeliveryConnectors().find((c) => c.key === "ozonexpress");
    expect(connector).toBeDefined();
    expect(connector!.displayName).toBe("OzonExpress (Maroc)");
    expect(connector!.credentialFields.map((f) => f.name)).toEqual(["customerId", "apiKey"]);
    expect(connector!.credentialFields.find((f) => f.name === "apiKey")?.type).toBe("password");
    // capabilities the documentation supports — no cancel, no webhooks
    expect([...connector!.capabilities].sort()).toEqual(["CREATE_SHIPMENT", "FETCH_COST", "FETCH_STATUS", "GENERATE_MANIFEST"]);
  });

  it("does NOT leak any test/fixture adapter into production", () => {
    expect(listDeliveryProviders().map((a) => a.key)).not.toContain("__test_reference__");
  });
});
