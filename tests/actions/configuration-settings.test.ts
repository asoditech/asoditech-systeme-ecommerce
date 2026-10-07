import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  updateBusinessSettingsAction,
  updateDefaultShippingProviderAction,
  updatePackingVerificationAction,
  updateSellerPriceOverrideAction,
} from "@/actions/settings";
import { setWooCommerceForceNouvelleOnImportAction } from "@/actions/woocommerce";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Paramètres → Configuration: each section saves ONLY its own fields through
 * the existing actions; permissions unchanged (settings.manage = OWNER/ADMIN).
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const read = () => prisma.businessSettings.findFirstOrThrow();

describe("updateBusinessSettingsAction — per-section saves", () => {
  it("saving one section never resets another (company, orders, stock, support)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    expect((await updateBusinessSettingsAction(fd({ companyName: "100 D ryal", city: "Rabat", email: "a@b.ma" }))).ok).toBe(true);
    expect((await updateBusinessSettingsAction(fd({ supportName: "Support", supportWhatsapp: "+212600112233" }))).ok).toBe(true);
    expect((await updateBusinessSettingsAction(fd({ orderNumberPrefix: "BTQ" }))).ok).toBe(true);
    expect((await updateBusinessSettingsAction(fd({ lowStockDefaultThreshold: "0" }))).ok).toBe(true);
    expect((await updateBusinessSettingsAction(fd({ supportHours: "9h–18h" }))).ok).toBe(true);

    const s = await read();
    expect(s).toMatchObject({
      companyName: "100 D ryal",
      city: "Rabat",
      email: "a@b.ma",
      supportName: "Support",
      supportWhatsapp: "+212600112233",
      supportHours: "9h–18h",
      orderNumberPrefix: "BTQ",
      lowStockDefaultThreshold: 0, // a stored 0 survives other sections' saves
      currency: "MAD",
      timezone: "Africa/Casablanca", // not offered in the UI, kept as is
    });
  });

  it("a field sent empty is cleared; an empty threshold falls back to 5 as before", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await updateBusinessSettingsAction(fd({ supportName: "Support", supportPhone: "+212522445566" }));
    await updateBusinessSettingsAction(fd({ supportName: "Support", supportPhone: "" }));
    expect(await read()).toMatchObject({ supportName: "Support", supportPhone: null });
    await updateBusinessSettingsAction(fd({ lowStockDefaultThreshold: "" }));
    expect((await read()).lowStockDefaultThreshold).toBe(5);
  });

  it("validation is unchanged: invalid values are refused and nothing is written", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await updateBusinessSettingsAction(fd({ companyName: "Avant" }));
    const bad = await updateBusinessSettingsAction(fd({ supportWhatsapp: "pas un numéro", companyName: "Après" }));
    expect(bad.ok).toBe(false);
    expect((await read()).companyName).toBe("Avant");
    expect((await updateBusinessSettingsAction(fd({ orderNumberPrefix: "" }))).ok).toBe(true); // "" → default CMD, as before
    expect((await read()).orderNumberPrefix).toBe("CMD");
  });

  it("permissions unchanged: only settings.manage (OWNER / ADMIN)", async () => {
    for (const role of ["MANAGER", "CONFIRMATION", "WAREHOUSE"] as const) {
      mockCookieStore.clear();
      await loginAsTestUser({ role });
      await expect(updateBusinessSettingsAction(fd({ companyName: "X" })), role).rejects.toThrow(/non autorisé/i);
      await expect(updatePackingVerificationAction(fd({ packingVerificationRequired: "true" })), role).rejects.toThrow(/non autorisé/i);
    }
  });
});

describe("the other Configuration switches/selects reuse their existing actions", () => {
  it("packing, seller price override, default carrier and shop import toggle", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "OWNER" });
    expect((await updatePackingVerificationAction(fd({ packingVerificationRequired: "true" }))).ok).toBe(true);
    expect((await updateSellerPriceOverrideAction(fd({ allowSellerPriceOverride: "true" }))).ok).toBe(true);
    const provider = await prisma.shippingProvider.create({ data: { name: "Ozon", type: "MANUEL" } });
    expect((await updateDefaultShippingProviderAction(fd({ defaultShippingProviderId: provider.id }))).ok).toBe(true);
    expect(await read()).toMatchObject({ packingVerificationRequired: true, allowSellerPriceOverride: true, defaultShippingProviderId: provider.id });

    // The section saves above did not touch the company fields.
    await updateBusinessSettingsAction(fd({ companyName: "Boutique" }));
    expect(await read()).toMatchObject({ companyName: "Boutique", packingVerificationRequired: true, allowSellerPriceOverride: true });

    await prisma.integration.create({ data: { provider: "WOOCOMMERCE", config: { siteUrl: "https://shop.test" } } });
    expect((await setWooCommerceForceNouvelleOnImportAction(false)).ok).toBe(true);
    const woo = await prisma.integration.findFirstOrThrow({ where: { provider: "WOOCOMMERCE" } });
    expect(woo.config).toMatchObject({ siteUrl: "https://shop.test", forceNouvelleOnImport: false });
  });
});
