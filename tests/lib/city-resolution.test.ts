import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  resolveProviderCity,
  providerExposesCityCatalogue,
  localCityKey,
} from "@/lib/integrations/delivery/city-resolution";
import type { DeliveryProviderAdapter } from "@/lib/integrations/delivery/types";
import { resetDb } from "../helpers/db";

const CATALOGUE = [
  { id: "1", name: "Casablanca" },
  { id: "2", name: "Rabat" },
  { id: "3", name: "Fès" },
  { id: "4", name: "Marrakech" },
];

async function seedProvider(name: string) {
  return prisma.shippingProvider.create({ data: { name, type: "API" } });
}

describe("resolveProviderCity — generic, provider-agnostic city resolution", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("safe exact normalized match against the catalogue (case / accents / whitespace)", async () => {
    const provider = await seedProvider("P");
    for (const local of ["Casablanca", "  casablanca ", "CASABLANCA"]) {
      const r = await resolveProviderCity({
        shippingProviderId: provider.id,
        localCity: local,
        availableProviderCities: CATALOGUE,
      });
      expect(r).toMatchObject({ status: "resolved", providerCityId: "1", source: "catalogue" });
    }
    const accent = await resolveProviderCity({
      shippingProviderId: provider.id,
      localCity: "Fes",
      availableProviderCities: CATALOGUE,
    });
    expect(accent).toMatchObject({ status: "resolved", providerCityId: "3" });
  });

  it("no catalogue match → unresolved (never a guess)", async () => {
    const provider = await seedProvider("P");
    const r = await resolveProviderCity({
      shippingProviderId: provider.id,
      localCity: "Ifrane",
      availableProviderCities: CATALOGUE,
    });
    expect(r.status).toBe("unresolved");
  });

  it("more than one catalogue entry normalizing the same → ambiguous, both candidates, never auto-picked", async () => {
    const provider = await seedProvider("P");
    const r = await resolveProviderCity({
      shippingProviderId: provider.id,
      localCity: "Casablanca",
      availableProviderCities: [
        { id: "1", name: "Casablanca" },
        { id: "99", name: "casablanca" },
      ],
    });
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates.map((c) => c.id).sort()).toEqual(["1", "99"]);
  });

  it("an explicit persisted mapping WINS over an automatic catalogue match", async () => {
    const provider = await seedProvider("P");
    await prisma.deliveryCityMapping.create({
      data: {
        shippingProviderId: provider.id,
        localCityKey: localCityKey("Casablanca"),
        localCityLabel: "Casablanca",
        providerCityId: "777",
        providerCityName: "Casablanca — Sidi Maarouf",
      },
    });
    const r = await resolveProviderCity({
      shippingProviderId: provider.id,
      localCity: "casablanca",
      availableProviderCities: CATALOGUE,
    });
    expect(r).toMatchObject({
      status: "resolved",
      providerCityId: "777",
      providerCityName: "Casablanca — Sidi Maarouf",
      source: "mapping",
    });
  });

  it("an explicit mapping resolves a city the catalogue would call ambiguous / would not find", async () => {
    const provider = await seedProvider("P");
    await prisma.deliveryCityMapping.create({
      data: {
        shippingProviderId: provider.id,
        localCityKey: localCityKey("Ifrane"),
        localCityLabel: "Ifrane",
        providerCityId: "500",
        providerCityName: "Ifrane",
      },
    });
    const r = await resolveProviderCity({
      shippingProviderId: provider.id,
      localCity: "Ifrane",
      availableProviderCities: CATALOGUE,
    });
    expect(r).toMatchObject({ status: "resolved", providerCityId: "500", source: "mapping" });
  });

  it("the same local city maps independently for different providers", async () => {
    const a = await seedProvider("A");
    const b = await seedProvider("B");
    await prisma.deliveryCityMapping.create({
      data: { shippingProviderId: a.id, localCityKey: localCityKey("Casablanca"), localCityLabel: "Casablanca", providerCityId: "A-CAS", providerCityName: "Casa" },
    });
    await prisma.deliveryCityMapping.create({
      data: { shippingProviderId: b.id, localCityKey: localCityKey("Casablanca"), localCityLabel: "Casablanca", providerCityId: "4567", providerCityName: "Casablanca" },
    });

    const ra = await resolveProviderCity({ shippingProviderId: a.id, localCity: "Casablanca", availableProviderCities: [] });
    const rb = await resolveProviderCity({ shippingProviderId: b.id, localCity: "Casablanca", availableProviderCities: [] });
    expect(ra).toMatchObject({ status: "resolved", providerCityId: "A-CAS" });
    expect(rb).toMatchObject({ status: "resolved", providerCityId: "4567" });
  });

  it("a mapping is scoped to its provider — it does not leak to a provider that has none", async () => {
    const a = await seedProvider("A");
    const b = await seedProvider("B");
    await prisma.deliveryCityMapping.create({
      data: { shippingProviderId: a.id, localCityKey: localCityKey("Casablanca"), localCityLabel: "Casablanca", providerCityId: "A-CAS", providerCityName: "Casa" },
    });
    const rb = await resolveProviderCity({ shippingProviderId: b.id, localCity: "Casablanca", availableProviderCities: [] });
    expect(rb.status).toBe("unresolved");
  });

  it("no catalogue and no mapping → unresolved, never fabricates an id", async () => {
    const provider = await seedProvider("P");
    const r = await resolveProviderCity({
      shippingProviderId: provider.id,
      localCity: "Casablanca",
      availableProviderCities: [],
    });
    expect(r.status).toBe("unresolved");
  });
});

describe("providerExposesCityCatalogue", () => {
  const base = { key: "x", displayName: "X", testConnection: async () => ({ ok: true as const }) };

  it("true only when FETCH_CITIES is declared AND listCities is implemented", () => {
    expect(
      providerExposesCityCatalogue({
        ...base,
        capabilities: ["FETCH_CITIES"],
        listCities: async () => [],
      } as DeliveryProviderAdapter)
    ).toBe(true);
  });

  it("false when the capability is declared but listCities is missing", () => {
    expect(
      providerExposesCityCatalogue({ ...base, capabilities: ["FETCH_CITIES"] } as DeliveryProviderAdapter)
    ).toBe(false);
  });

  it("false when listCities exists but the capability is not declared", () => {
    expect(
      providerExposesCityCatalogue({
        ...base,
        capabilities: ["CREATE_SHIPMENT"],
        listCities: async () => [],
      } as DeliveryProviderAdapter)
    ).toBe(false);
  });
});
