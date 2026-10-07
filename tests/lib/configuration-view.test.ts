import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BusinessSettings } from "@prisma/client";

// The existing setting forms call useRouter(); the shared setup only mocks redirect/notFound.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/parametres",
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { ConfigurationView } = await import("@/components/settings/configuration-view");
import {
  CONFIG_SECTIONS,
  configAttention,
  configHealth,
  identityCompletion,
  orderNumberPreview,
  resolveConfigSection,
  searchSettings,
  sectionSummary,
  settingsIndex,
} from "@/lib/settings/configuration-model";
type Props = Parameters<typeof ConfigurationView>[0];

/**
 * Paramètres → Configuration control center: hero (identity, health, search),
 * pill navigation, a visual overview (attention cards, section tiles, dedicated
 * pages), section workspaces of switch / value tiles — every setting saved
 * through its existing action; advanced pages only linked.
 */

const settings = {
  id: "s1",
  tenantId: "default",
  companyName: "100 D ryal",
  currency: "MAD",
  address: "12 rue Atlas",
  city: "Rabat",
  country: "Maroc",
  phone: "0522000000",
  email: "contact@boutique.ma",
  logoUrl: null,
  timezone: "Africa/Casablanca",
  locale: "fr",
  lowStockDefaultThreshold: 7,
  orderNumberPrefix: "BTQ",
  costingMethod: "WEIGHTED_AVERAGE",
  supportName: "Support Boutique",
  supportWhatsapp: "+212600112233",
  supportPhone: "+212522445566",
  supportEmail: "support@boutique.ma",
  supportHours: "Lun–Sam, 9h–18h",
  allowSellerPriceOverride: true,
  defaultShippingProviderId: "prov-1",
  packingVerificationRequired: true,
  transferPurchaseCostOverrideEnabled: true,
  updatedAt: new Date("2026-10-06T00:00:00Z"),
} as unknown as BusinessSettings;

const allLinks = { channels: true, delivery: true, warehouses: true, integrations: true, commissions: true, backup: true };

/** The switch named `label`: its checked state, or null if absent. */
function switchState(html: string, label: string): boolean | null {
  const esc = label.replace(/'/g, "&#x27;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`role="switch"[^>]*aria-checked="(true|false)"[^>]*aria-label="${esc}"`));
  return m ? m[1] === "true" : null;
}

function render(over: Partial<Props> = {}) {
  const props: Props = {
    settings,
    offlineSales: true,
    imports: { woocommerce: true, shopify: null },
    canManageIntegrations: true,
    providers: [{ id: "prov-1", name: "OzonExpress", hasCityList: true }],
    links: allLinks,
    ...over,
  };
  return renderToStaticMarkup(createElement(ConfigurationView, props));
}

const ctx = (over: Partial<typeof settings> = {}, extra: Record<string, unknown> = {}) => ({
  settings: { ...settings, ...over },
  offlineSales: true,
  imports: { woocommerce: true, shopify: null },
  providers: [{ id: "prov-1", name: "OzonExpress" }],
  canManageCost: true,
  ...extra,
}) as Parameters<typeof configAttention>[0];

describe("model", () => {
  it("seven sections, overview first; unknown section → overview", () => {
    expect(CONFIG_SECTIONS.map((c) => c.label)).toEqual([
      "Vue d'ensemble",
      "Entreprise",
      "Commandes",
      "Expédition & livraison",
      "Ventes magasin",
      "Stock & achats",
      "Support",
    ]);
    expect(resolveConfigSection(undefined)).toBe("apercu");
    expect(resolveConfigSection("stock")).toBe("stock");
    expect(resolveConfigSection("nope")).toBe("apercu");
  });

  it("only genuine gaps are flagged — each with its section and the tile to fix", () => {
    expect(configAttention(ctx())).toEqual([]);
    const items = configAttention(
      ctx(
        { companyName: " ", email: null, phone: null, supportWhatsapp: null, supportPhone: null, supportEmail: null, defaultShippingProviderId: null },
        { providers: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }
      )
    );
    expect(items.map((i) => `${i.section}#${i.anchor}`)).toEqual(["entreprise#identite", "entreprise#identite", "expedition#transporteur", "support#contacts"]);
    expect(configAttention(ctx({ defaultShippingProviderId: "gone" }))[0]).toMatchObject({ section: "expedition", message: expect.stringMatching(/plus actif/) });
    // An empty OPTIONAL field (logo, address, support hours) is not a gap.
    expect(configAttention(ctx({ logoUrl: null, address: null, supportHours: null }))).toEqual([]);
  });

  it("health, identity completion and the key value of each section", () => {
    expect(configHealth(ctx())).toEqual({ sections: 6, sectionsOk: 6, attention: 0, switchesOn: 4, switchesTotal: 4 });
    expect(identityCompletion(ctx().settings).percent).toBe(83); // no logo
    expect(orderNumberPreview("BTQ")).toBe("BTQ-000124");
    expect(sectionSummary(ctx(), "commandes").value).toBe("BTQ-000124");
    expect(sectionSummary(ctx(), "stock").value).toBe("Coût moyen pondéré");
    expect(sectionSummary(ctx(), "expedition").value).toBe("OzonExpress");
    expect(sectionSummary(ctx(), "support").value).toBe("3 / 3");
    expect(sectionSummary(ctx({}, { offlineSales: false }), "magasin").value).toBe("Non activé");
  });

  it("search finds settings accent- and case-insensitively, only those that exist for this user", () => {
    const index = settingsIndex(ctx());
    expect(searchSettings(index, "EMBALLAGE").map((r) => r.anchor)).toEqual(["emballage"]);
    expect(searchSettings(index, "cout transfert").map((r) => r.anchor)).toEqual(["cout-transferts"]);
    expect(searchSettings(index, "")).toEqual([]);
    expect(searchSettings(settingsIndex(ctx({}, { canManageCost: false })), "transfert")).toEqual([]);
    expect(searchSettings(settingsIndex(ctx({}, { offlineSales: false })), "vendeur")).toEqual([]);
  });
});

describe("overview", () => {
  it("hero: identity, health and the settings search", () => {
    const html = render();
    expect(html).toContain("Centre de contrôle");
    expect(html).toContain("100 D ryal");
    expect(html).toContain("sections en ordre");
    expect(html).toContain("fonctions activées");
    expect(html).toContain('aria-label="Rechercher un réglage"');
  });

  it("pill navigation links every section by URL and marks the current one", () => {
    const html = render({ section: "stock" });
    expect(html).toContain('aria-label="Sections de la configuration"');
    for (const id of ["entreprise", "commandes", "expedition", "magasin", "stock", "support"]) {
      expect(html).toContain(`href="/parametres?section=${id}"`);
    }
    const current = html.match(/<a[^>]*aria-current="page"[^>]*>/g) ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/parametres?section=stock"');
  });

  it("one visual tile per section with its key value and switch states", () => {
    const html = render();
    expect(html).toContain("Vos réglages");
    expect(html).toContain("BTQ-000124");
    expect(html).toContain("Coût moyen pondéré");
    expect(html).toContain("Vérification de l&#x27;emballage");
    expect((html.match(/>Ouvrir</g) ?? []).length).toBe(6);
  });

  it("attention cards appear only for genuine gaps and link to the tile to fix", () => {
    expect(render()).not.toContain("À corriger");
    const html = render({ settings: { ...settings, supportWhatsapp: null, supportPhone: null, supportEmail: null } });
    expect(html).toContain("À corriger");
    expect(html).toContain("Contacts support");
    expect(html).toContain('href="/parametres?section=support#contacts"');
  });

  it("only the selected section's settings are rendered", () => {
    expect(render()).not.toContain('name="companyName"');
    const stock = render({ section: "stock" });
    expect(stock).not.toContain('name="companyName"');
    expect(render({ section: "entreprise" })).toContain('name="companyName"');
  });

  it("responsive: the navigation scrolls sideways on phones; never sticky", () => {
    const html = render();
    expect(html).toContain("overflow-x-auto");
    expect(html).not.toContain("sticky");
  });
});

describe("section workspaces", () => {
  it("Entreprise: document preview + identity form with the stored values; currency shown, not editable", () => {
    const html = render({ section: "entreprise" });
    expect(html).toContain("Aperçu sur vos documents");
    for (const v of ["100 D ryal", "12 rue Atlas", "contact@boutique.ma", "Rabat"]) expect(html, v).toContain(v);
    expect(html).toContain("MAD");
    expect(html).not.toContain('name="currency"');
    expect(html).not.toContain('name="timezone"');
    expect(html).not.toContain('name="locale"');
    expect(html).toContain('data-state="clean"'); // no save bar until something changes
  });

  it("Commandes: the prefix as a previewed value; the import switch per connected shop", () => {
    const html = render({ section: "commandes" });
    expect(html).toContain("BTQ-000124");
    expect(html).toContain('aria-label="Modifier : Numéro des commandes"');
    expect(html).not.toContain('name="orderNumberPrefix"'); // editor closed
    expect(switchState(html, "WooCommerce : importer en « Nouvelle »")).toBe(true);
    const readOnly = render({ section: "commandes", canManageIntegrations: false, imports: { woocommerce: false, shopify: null } });
    expect(switchState(readOnly, "WooCommerce : importer en « Nouvelle »")).toBeNull();
    expect(readOnly).toContain("Modifiable par les utilisateurs qui gèrent les intégrations");
    expect(render({ section: "commandes", imports: { woocommerce: null, shopify: null } })).toContain("Aucune boutique WooCommerce ou Shopify connectée");
  });

  it("Expédition: packing verification as an immediate switch; the carrier previewed", () => {
    const html = render({ section: "expedition" });
    expect(switchState(html, "Vérification avant expédition")).toBe(true);
    expect(switchState(render({ section: "expedition", settings: { ...settings, packingVerificationRequired: false } }), "Vérification avant expédition")).toBe(false);
    expect(html).toContain("OzonExpress");
    expect(html).toContain('href="/livraison/suivi"');
  });

  it("Ventes magasin: switch when the store mode is on; an explanation when it is off", () => {
    expect(switchState(render({ section: "magasin" }), "Prix modifiable par les vendeurs")).toBe(true);
    const off = render({ section: "magasin", offlineSales: false });
    expect(switchState(off, "Prix modifiable par les vendeurs")).toBeNull();
    expect(off).toContain("Ventes magasin non activées");
  });

  it("Stock & achats: threshold and costing method previewed; transfer purchase cost for finance.view only", () => {
    const html = render({ section: "stock", canManageCost: true });
    expect(html).toContain("Coût moyen pondéré");
    expect(html).toMatch(/>7 <span[^>]*>unités/);
    expect(switchState(html, "Coût d'achat lors des transferts")).toBe(true);
    expect(html).toContain("Réservé aux utilisateurs ayant accès aux données financières");
    const without = render({ section: "stock" });
    expect(switchState(without, "Coût d'achat lors des transferts")).toBeNull();
    expect(without).toContain("Réservé aux utilisateurs ayant accès aux données financières.");
  });

  it("Support: help-centre preview with configured contacts + the contact form", () => {
    const html = render({ section: "support" });
    expect(html).toContain("Ce que voient vos équipes");
    for (const v of ["Support Boutique", "+212600112233", "support@boutique.ma", "Lun–Sam, 9h–18h"]) expect(html, v).toContain(v);
    expect(html).toContain('name="supportEmail"');
    expect(html).not.toContain('name="companyName"'); // each form posts only its own fields
  });
});

describe("advanced pages are linked, not duplicated — and only when the user may open them", () => {
  it("overview and contextual links", () => {
    const overview = render();
    for (const href of ["/integrations", "/livraison?tab=prestataires", "/parametres/canaux", "/entrepots", "/commissions", "/parametres/sauvegarde"]) {
      expect(overview, href).toContain(`href="${href}"`);
    }
    expect(render({ section: "expedition" })).not.toContain('name="returnCost"');
  });

  it("hidden without permission", () => {
    const none = { channels: false, delivery: false, warehouses: false, integrations: false, commissions: false, backup: false };
    for (const section of ["apercu", "commandes", "expedition", "magasin", "stock"] as const) {
      const html = render({ section, links: none });
      for (const href of ["/parametres/canaux", "/entrepots", "/integrations", "/commissions", "/parametres/sauvegarde", "/livraison?tab=prestataires"]) {
        expect(html, `${section} ${href}`).not.toContain(`href="${href}"`);
      }
    }
    expect(render({ section: "expedition", links: none })).toContain("nécessite l&#x27;accès « Livraison »");
  });

  it("platform-owned settings stay out (business mode, plan, permissions)", () => {
    for (const section of CONFIG_SECTIONS.map((c) => c.id)) {
      expect(render({ section })).not.toMatch(/businessMode|Forfait|Permissions/);
    }
  });
});
