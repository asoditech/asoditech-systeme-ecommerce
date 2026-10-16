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
    // capabilities the documentation supports — no cancel, no webhooks.
    // FETCH_TRACKING added for the « Suivi » module (docs/adr/0033).
    expect([...connector!.capabilities].sort()).toEqual([
      "CREATE_SHIPMENT",
      "FETCH_CITIES",
      "FETCH_COST",
      "FETCH_STATUS",
      "FETCH_TRACKING",
      "GENERATE_MANIFEST",
    ]);
  });

  it("registers Aramex with its six ClientInfo credential fields (secrets masked)", () => {
    expect(listDeliveryProviders().map((a) => a.key)).toContain("aramex");
    const connector = listAvailableDeliveryConnectors().find((c) => c.key === "aramex");
    expect(connector).toBeDefined();
    expect(connector!.displayName).toBe("Aramex");
    expect(connector!.credentialFields.map((f) => f.name)).toEqual([
      "userName",
      "password",
      "accountNumber",
      "accountPin",
      "accountEntity",
      "accountCountryCode",
    ]);
    expect(connector!.credentialFields.find((f) => f.name === "password")?.type).toBe("password");
    expect(connector!.credentialFields.find((f) => f.name === "accountPin")?.type).toBe("password");
    // No cancel, no cities, no manifest, no webhooks — Aramex JSON API scope.
    // FETCH_TRACKING added for the « Suivi » module (docs/adr/0033).
    expect([...connector!.capabilities].sort()).toEqual([
      "CREATE_SHIPMENT",
      "FETCH_COST",
      "FETCH_STATUS",
      "FETCH_TRACKING",
    ]);
  });

  // 2026-10-16: Sendit is now registered (client + adapter implemented from
  // the official spec, not yet validated on a real account), so the
  // registered set checked here grows by one.
  it("registers Sendit for new connections, with masked secret key and the not-validated notice", () => {
    const connector = listAvailableDeliveryConnectors().find((c) => c.key === "sendit");
    expect(connector).toBeDefined();
    expect(connector!.displayName).toBe("Sendit (Maroc)");
    expect(connector!.acceptsNewConnections).toBe(true);
    expect(connector!.notice).toContain("pas encore validé sur un compte réel");
    expect(connector!.credentialFields.map((f) => f.name)).toEqual(["publicKey", "secretKey"]);
    expect(connector!.credentialFields.find((f) => f.name === "secretKey")?.type).toBe("password");
    expect(connector!.credentialFields.find((f) => f.name === "publicKey")?.type).toBe("text");
    // No cancel (DELETE semantics undocumented), no webhooks (none documented).
    expect([...connector!.capabilities].sort()).toEqual([
      "CREATE_SHIPMENT",
      "FETCH_CITIES",
      "FETCH_COST",
      "FETCH_LABEL",
      "FETCH_STATUS",
      "FETCH_TRACKING",
    ]);
  });

  it("Sendit sits next to OzonExpress (new connections) and Aramex (retired for new)", () => {
    const connectors = listAvailableDeliveryConnectors();
    const keys = connectors.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["aramex", "ozonexpress", "sendit"]));
    expect(connectors.find((c) => c.key === "aramex")?.acceptsNewConnections).toBe(false);
    expect(connectors.find((c) => c.key === "ozonexpress")?.acceptsNewConnections).toBe(true);
  });

  // 2026-10-16: Ameex is registered (sandbox-verified only, production key
  // not tested) — selectable for new connections with a sandbox-only notice.
  it("registers Ameex for new connections, with masked secrets and the sandbox-only notice", () => {
    const connector = listAvailableDeliveryConnectors().find((c) => c.key === "ameex");
    expect(connector).toBeDefined();
    expect(connector!.displayName).toBe("Ameex (Maroc)");
    expect(connector!.acceptsNewConnections).toBe(true);
    expect(connector!.notice).toMatch(/bac à sable/);
    expect(connector!.credentialFields.map((f) => [f.name, f.type])).toEqual([
      ["apiId", "text"],
      ["apiKey", "password"],
      ["webhookSecret", "password"],
    ]);
    // No cancel / labels / manifest / prices (undocumented by Ameex).
    expect([...connector!.capabilities].sort()).toEqual([
      "CREATE_SHIPMENT",
      "FETCH_CITIES",
      "FETCH_STATUS",
      "FETCH_TRACKING",
      "WEBHOOKS",
    ]);
  });

  it("does NOT leak any test/fixture adapter into production", () => {
    expect(listDeliveryProviders().map((a) => a.key)).not.toContain("__test_reference__");
  });
});
