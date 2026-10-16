import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createShippingProviderAction, configureDeliveryProviderApiAction } from "@/actions/delivery";
import { listAvailableDeliveryConnectors, providerCapabilities } from "@/lib/queries/delivery";
import { getDeliveryProvider } from "@/lib/integrations/delivery/registry";
import "@/lib/integrations/delivery/providers";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Aramex is retired for NEW connections (docs/adr/0060) — hidden from the
 * choice and refused server-side — while existing Aramex connections keep
 * working. Nothing is deleted or unregistered.
 */

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const ARAMEX_CREDS = JSON.stringify({ userName: "u", password: "p", accountNumber: "1", accountPin: "2", accountEntity: "CAS", accountCountryCode: "MA" });

async function newApiProvider(name: string) {
  const r = await createShippingProviderAction(fd({ name, type: "API" }));
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("Aramex retired for new connections", () => {
  it("stays registered (existing connections resolve it) but is flagged as not offered", () => {
    expect(getDeliveryProvider("aramex")).toBeDefined();
    const aramex = listAvailableDeliveryConnectors().find((c) => c.key === "aramex");
    expect(aramex?.acceptsNewConnections).toBe(false);
    expect(listAvailableDeliveryConnectors().find((c) => c.key === "ozonexpress")?.acceptsNewConnections).toBe(true);
  });

  it("a new connection cannot choose Aramex (server-side refusal, nothing written)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const id = await newApiProvider("Nouveau transporteur");
    const r = await configureDeliveryProviderApiAction(fd({ providerId: id, providerKey: "aramex", credentialsJson: ARAMEX_CREDS }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/plus proposé pour de nouvelles connexions/);
    const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id } });
    expect(row.providerKey).toBeNull();
    expect(row.credentialsEncrypted).toBeNull();
  });

  it("an existing Aramex connection can still re-save its credentials and keeps its capabilities", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const id = await newApiProvider("Aramex existant");
    // An Aramex connection created before the retirement.
    await prisma.shippingProvider.update({ where: { id }, data: { providerKey: "aramex" } });
    const r = await configureDeliveryProviderApiAction(fd({ providerId: id, providerKey: "aramex", credentialsJson: ARAMEX_CREDS }));
    expect(r.ok).toBe(true);
    const row = await prisma.shippingProvider.findUniqueOrThrow({ where: { id } });
    expect(row.providerKey).toBe("aramex");
    expect(providerCapabilities(row)).toContain("FETCH_STATUS");
  });

  it("OzonExpress is still offered to new connections", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const id = await newApiProvider("Ozon");
    const r = await configureDeliveryProviderApiAction(
      fd({ providerId: id, providerKey: "ozonexpress", credentialsJson: JSON.stringify({ customerId: "c", apiKey: "k" }) })
    );
    expect(r.ok).toBe(true);
  });

  // 2026-10-16: Sendit is now registered (implemented from the official
  // spec, not yet validated on a real account) and offered to new
  // connections. (Ameex registration is tracked by its own tests.)
  it("Sendit is selectable for new connections", () => {
    const connectors = listAvailableDeliveryConnectors();
    expect(connectors.find((c) => c.key === "sendit")?.acceptsNewConnections).toBe(true);
  });
});
