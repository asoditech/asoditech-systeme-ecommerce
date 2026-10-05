import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The carrier catalogue call is the only external dependency — stubbed so each
// scenario (city list / empty / API failure) is deterministic.
const catalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/integrations/delivery/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/integrations/delivery/service")>();
  return { ...mod, fetchProviderCityCatalogue: catalogue.fn };
});

import { prisma, prismaBase } from "@/lib/prisma";
import { getDeliveryCitySuggestionsAction } from "@/actions/delivery";
import { updateDefaultShippingProviderAction } from "@/actions/settings";
import { clearCityCatalogueCache, getCitySuggestions } from "@/lib/queries/delivery-cities";
import { normalizeCityNames, pickCitySourceProvider } from "@/lib/delivery-cities";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * City field on online orders / customers: the delivery company's city list
 * when one decides it (single active company, or the « Transporteur par
 * défaut »), else free text — never blocking. The default only drives
 * suggestions; shipment provider choice is unchanged.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  clearCityCatalogueCache();
  catalogue.fn.mockReset();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const withCities = { capabilities: ["CREATE_SHIPMENT", "FETCH_CITIES"] };
const noCities = { capabilities: ["CREATE_SHIPMENT"] };
const provider = (name: string, extra: { capabilities: string[]; isActive?: boolean }) =>
  prisma.shippingProvider.create({ data: { name, type: "API", providerKey: "ozonexpress", isActive: extra.isActive ?? true, capabilities: extra.capabilities } });
const setDefault = (id: string | null) =>
  prisma.businessSettings.upsert({ where: { tenantId: "default" }, update: { defaultShippingProviderId: id }, create: { defaultShippingProviderId: id } });

describe("pure rules", () => {
  it("picks the single provider, the valid default among several, or none", () => {
    const a = { id: "a", name: "A", capabilities: [] };
    const b = { id: "b", name: "B", capabilities: [] };
    expect(pickCitySourceProvider([], null)).toEqual({ provider: null, reason: "no_provider" });
    expect(pickCitySourceProvider([a], null)).toEqual({ provider: a });
    expect(pickCitySourceProvider([a], "zzz")).toEqual({ provider: a }); // one company: the default is irrelevant
    expect(pickCitySourceProvider([a, b], "b")).toEqual({ provider: b });
    expect(pickCitySourceProvider([a, b], null)).toEqual({ provider: null, reason: "several_no_default" });
    expect(pickCitySourceProvider([a, b], "gone")).toEqual({ provider: null, reason: "several_no_default" });
  });
  it("city names are trimmed, de-duplicated case-insensitively and sorted", () => {
    expect(normalizeCityNames([" Rabat", "casablanca", "Casablanca", "", "Agadir"])).toEqual(["Agadir", "casablanca", "Rabat"]);
  });
});

describe("getCitySuggestions", () => {
  it("zero active providers → free text (no carrier call)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await provider("Inactif", { ...withCities, isActive: false });
    expect(await getCitySuggestions()).toEqual({ mode: "free", reason: "no_provider" });
    expect(catalogue.fn).not.toHaveBeenCalled();
  });

  it("one provider WITH a city list → its cities", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const p = await provider("OzonExpress", withCities);
    catalogue.fn.mockResolvedValue({ supported: true, cities: [{ id: "2", name: "Rabat" }, { id: "1", name: "Casablanca" }] });
    expect(await getCitySuggestions()).toEqual({ mode: "list", providerName: "OzonExpress", cities: ["Casablanca", "Rabat"] });
    expect(catalogue.fn).toHaveBeenCalledWith(p.id);
  });

  it("one provider WITHOUT a city list → free text", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await provider("Aramex", noCities);
    expect(await getCitySuggestions()).toEqual({ mode: "free", reason: "no_catalogue" });
    expect(catalogue.fn).not.toHaveBeenCalled();
  });

  it("several providers + default → the default's list; the other company is never queried", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await provider("Aramex", noCities);
    const ozon = await provider("OzonExpress", withCities);
    await setDefault(ozon.id);
    catalogue.fn.mockResolvedValue({ supported: true, cities: [{ id: "1", name: "Tanger" }] });
    expect(await getCitySuggestions()).toEqual({ mode: "list", providerName: "OzonExpress", cities: ["Tanger"] });
    expect(catalogue.fn).toHaveBeenCalledTimes(1);
  });

  it("several providers, no default or an invalid/inactive one → free text", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await provider("A", withCities);
    const b = await provider("B", withCities);
    expect(await getCitySuggestions()).toEqual({ mode: "free", reason: "several_no_default" });
    await setDefault(b.id);
    await prisma.shippingProvider.update({ where: { id: b.id }, data: { isActive: false } });
    await provider("C", withCities);
    expect(await getCitySuggestions()).toEqual({ mode: "free", reason: "several_no_default" });
    expect(catalogue.fn).not.toHaveBeenCalled();
  });

  it("carrier API failure or empty catalogue → free text, never an error; failures are not cached", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await provider("OzonExpress", withCities);
    catalogue.fn.mockRejectedValueOnce(new Error("timeout"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getCitySuggestions()).toEqual({ mode: "free", reason: "unavailable" });
    err.mockRestore();
    catalogue.fn.mockResolvedValueOnce({ supported: true, cities: [] });
    expect(await getCitySuggestions()).toEqual({ mode: "free", reason: "unavailable" });
    catalogue.fn.mockResolvedValueOnce({ supported: true, cities: [{ id: "1", name: "Fès" }] });
    expect((await getCitySuggestions()).mode).toBe("list"); // recovered on the next call
  });

  it("a successful list is cached (no second carrier call)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await provider("OzonExpress", withCities);
    catalogue.fn.mockResolvedValue({ supported: true, cities: [{ id: "1", name: "Fès" }] });
    await getCitySuggestions();
    await getCitySuggestions();
    expect(catalogue.fn).toHaveBeenCalledTimes(1);
  });
});

describe("server action + « Transporteur par défaut » setting", () => {
  it("suggestions are reserved to users who enter online orders/customers", async () => {
    await provider("OzonExpress", noCities);
    await loginAsTestUser({ role: "STORE_SELLER" });
    await expect(getDeliveryCitySuggestionsAction()).rejects.toThrow(/Non autorisé/);
    mockCookieStore.clear();
    await loginAsTestUser({ role: "CONFIRMATION" });
    expect(await getDeliveryCitySuggestionsAction()).toEqual({ mode: "free", reason: "no_catalogue" });
  });

  it("set / clear the default; refuses an inactive or another company's provider; settings.manage only", async () => {
    const ozon = await provider("OzonExpress", withCities);
    const inactive = await provider("Old", { ...withCities, isActive: false });
    await prismaBase.tenant.create({ data: { id: "tenant-b-carrier", name: "B", slug: "tenant-b-carrier" } });
    const foreign = await prismaBase.shippingProvider.create({ data: { tenantId: "tenant-b-carrier", name: "B carrier", type: "API" } });
    await loginAsTestUser({ role: "ADMIN" });
    const fd = (id: string) => {
      const f = new FormData();
      f.set("defaultShippingProviderId", id);
      return f;
    };
    expect((await updateDefaultShippingProviderAction(fd(ozon.id))).ok).toBe(true);
    expect((await prisma.businessSettings.findFirst())?.defaultShippingProviderId).toBe(ozon.id);
    expect((await updateDefaultShippingProviderAction(fd(inactive.id))).ok).toBe(false);
    expect((await updateDefaultShippingProviderAction(fd(foreign.id))).ok).toBe(false);
    expect((await prisma.businessSettings.findFirst())?.defaultShippingProviderId).toBe(ozon.id);
    expect((await updateDefaultShippingProviderAction(fd(""))).ok).toBe(true);
    expect((await prisma.businessSettings.findFirst())?.defaultShippingProviderId).toBeNull();

    mockCookieStore.clear();
    await loginAsTestUser({ role: "MANAGER" });
    await expect(updateDefaultShippingProviderAction(fd(ozon.id))).rejects.toThrow(/Non autorisé/);
  });

  it("deleting the default company clears the setting (ON DELETE SET NULL)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const ozon = await provider("OzonExpress", withCities);
    await setDefault(ozon.id);
    await prisma.shippingProvider.delete({ where: { id: ozon.id } });
    expect((await prisma.businessSettings.findFirst())?.defaultShippingProviderId).toBeNull();
  });
});
