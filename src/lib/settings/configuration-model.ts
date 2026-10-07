import type { BusinessSettings, CostingMethod } from "@prisma/client";

/**
 * Paramètres › Configuration — the "control center" model. Pure and
 * client-safe: it only READS stored settings to decide what the screen shows
 * (sections, their key value, health, attention, search). No business rule
 * lives here; every value is still saved by its existing server action.
 */

export const CONFIG_SECTIONS = [
  { id: "apercu", label: "Vue d'ensemble", short: "Vue d'ensemble", purpose: "L'état de votre configuration en un coup d'œil." },
  { id: "entreprise", label: "Entreprise", short: "Entreprise", purpose: "Votre identité sur les documents et rapports." },
  { id: "commandes", label: "Commandes", short: "Commandes", purpose: "Numérotation et arrivée des commandes en ligne." },
  { id: "expedition", label: "Expédition & livraison", short: "Expédition", purpose: "Contrôle avant envoi et transporteur proposé." },
  { id: "magasin", label: "Ventes magasin", short: "Magasin", purpose: "Les règles de votre caisse en magasin." },
  { id: "stock", label: "Stock & achats", short: "Stock", purpose: "Seuils de stock et calcul du coût d'achat." },
  { id: "support", label: "Support", short: "Support", purpose: "Comment vos équipes vous joignent." },
] as const;

export type ConfigSectionId = (typeof CONFIG_SECTIONS)[number]["id"];
export type ConfigWorkspaceId = Exclude<ConfigSectionId, "apercu">;

export function resolveConfigSection(param: string | string[] | undefined): ConfigSectionId {
  const v = Array.isArray(param) ? param[0] : param;
  return CONFIG_SECTIONS.some((s) => s.id === v) ? (v as ConfigSectionId) : "apercu";
}

export const sectionHref = (id: ConfigSectionId, anchor?: string) =>
  `${id === "apercu" ? "/parametres" : `/parametres?section=${id}`}${anchor ? `#${anchor}` : ""}`;

export const COSTING_METHOD_LABELS: Record<CostingMethod, string> = {
  MANUAL: "Manuel",
  LAST_COST: "Dernier coût d'achat",
  WEIGHTED_AVERAGE: "Coût moyen pondéré",
};

export const COSTING_METHOD_HELP: Record<CostingMethod, string> = {
  MANUAL: "Vous saisissez le coût vous-même ; une réception ne le change pas.",
  LAST_COST: "Chaque réception validée remplace le coût par son prix d'achat.",
  WEIGHTED_AVERAGE: "Le coût est la moyenne du stock existant et des nouveaux achats.",
};

export type ConfigSettings = Pick<
  BusinessSettings,
  | "companyName"
  | "logoUrl"
  | "email"
  | "phone"
  | "address"
  | "city"
  | "orderNumberPrefix"
  | "lowStockDefaultThreshold"
  | "costingMethod"
  | "supportName"
  | "supportWhatsapp"
  | "supportPhone"
  | "supportEmail"
  | "allowSellerPriceOverride"
  | "defaultShippingProviderId"
  | "packingVerificationRequired"
  | "transferPurchaseCostOverrideEnabled"
>;

export interface ConfigContext {
  settings: ConfigSettings;
  offlineSales: boolean;
  imports: { woocommerce: boolean | null; shopify: boolean | null };
  providers: { id: string; name: string }[];
  canManageCost: boolean;
}

export interface AttentionItem {
  section: ConfigWorkspaceId;
  anchor: string;
  title: string;
  message: string;
}

/**
 * Genuine configuration gaps only — each one changes what users see
 * elsewhere in the app. Optional fields left empty are NOT gaps.
 */
export function configAttention(ctx: ConfigContext): AttentionItem[] {
  const s = ctx.settings;
  const items: AttentionItem[] = [];
  if (!s.companyName.trim()) {
    items.push({ section: "entreprise", anchor: "identite", title: "Nom de l'entreprise", message: "Vide : il apparaît sur les rapports et les factures de livraison." });
  }
  if (!s.email && !s.phone) {
    items.push({ section: "entreprise", anchor: "identite", title: "Contact de l'entreprise", message: "Aucun e-mail ni téléphone sur vos documents." });
  }
  if (s.defaultShippingProviderId && !ctx.providers.some((p) => p.id === s.defaultShippingProviderId)) {
    items.push({ section: "expedition", anchor: "transporteur", title: "Transporteur par défaut", message: "Il n'est plus actif : choisissez-en un autre." });
  } else if (ctx.providers.length > 1 && !s.defaultShippingProviderId) {
    items.push({ section: "expedition", anchor: "transporteur", title: "Transporteur par défaut", message: "Plusieurs transporteurs actifs sans choix : la ville est saisie librement." });
  }
  if (!s.supportWhatsapp && !s.supportPhone && !s.supportEmail) {
    items.push({ section: "support", anchor: "contacts", title: "Contacts support", message: "Le centre d'aide n'affiche aucun moyen de vous joindre." });
  }
  return items;
}

/** Identity completeness (what is printed on documents): 0–100. */
export function identityCompletion(s: ConfigSettings): { filled: number; total: number; percent: number } {
  const fields = [s.companyName.trim(), s.logoUrl, s.email, s.phone, s.address, s.city];
  const filled = fields.filter(Boolean).length;
  return { filled, total: fields.length, percent: Math.round((filled / fields.length) * 100) };
}

/** The next order number as customers will see it, e.g. "CMD-000124". */
export function orderNumberPreview(prefix: string, next = 124): string {
  return `${prefix}-${String(next).padStart(6, "0")}`;
}

export interface SwitchState {
  label: string;
  on: boolean;
}

/** The switches that exist for this tenant/user, per section (only those that apply). */
export function sectionSwitches(ctx: ConfigContext, id: ConfigWorkspaceId): SwitchState[] {
  const s = ctx.settings;
  switch (id) {
    case "commandes":
      return [
        ...(ctx.imports.woocommerce !== null ? [{ label: "WooCommerce en « Nouvelle »", on: ctx.imports.woocommerce }] : []),
        ...(ctx.imports.shopify !== null ? [{ label: "Shopify en « Nouvelle »", on: ctx.imports.shopify }] : []),
      ];
    case "expedition":
      return [{ label: "Vérification de l'emballage", on: s.packingVerificationRequired }];
    case "magasin":
      return ctx.offlineSales ? [{ label: "Prix modifiable par les vendeurs", on: s.allowSellerPriceOverride }] : [];
    case "stock":
      return ctx.canManageCost ? [{ label: "Coût d'achat lors des transferts", on: s.transferPurchaseCostOverrideEnabled }] : [];
    default:
      return [];
  }
}

export interface SectionSummary {
  id: ConfigWorkspaceId;
  /** The one value that best describes the section. */
  value: string;
  /** A short line under the value. */
  caption: string;
  switches: SwitchState[];
  attention: number;
}

export function sectionSummary(ctx: ConfigContext, id: ConfigWorkspaceId): SectionSummary {
  const s = ctx.settings;
  const attention = configAttention(ctx).filter((a) => a.section === id).length;
  const switches = sectionSwitches(ctx, id);
  const provider = ctx.providers.find((p) => p.id === s.defaultShippingProviderId);
  const contacts = [s.supportWhatsapp, s.supportPhone, s.supportEmail].filter(Boolean).length;
  const base = { id, switches, attention };
  switch (id) {
    case "entreprise": {
      const c = identityCompletion(s);
      return { ...base, value: s.companyName.trim() || "Sans nom", caption: `Identité complète à ${c.percent} %` };
    }
    case "commandes":
      return { ...base, value: orderNumberPreview(s.orderNumberPrefix), caption: "Prochain numéro de commande" };
    case "expedition":
      return { ...base, value: provider?.name ?? "Aucun transporteur", caption: "Transporteur proposé sur les commandes" };
    case "magasin":
      return ctx.offlineSales
        ? { ...base, value: s.allowSellerPriceOverride ? "Prix libre" : "Prix du catalogue", caption: "À la caisse" }
        : { ...base, value: "Non activé", caption: "Mode « En ligne » uniquement" };
    case "stock":
      return { ...base, value: COSTING_METHOD_LABELS[s.costingMethod], caption: `Stock faible à ${s.lowStockDefaultThreshold} unités` };
    case "support":
      return { ...base, value: `${contacts} / 3`, caption: contacts === 0 ? "Aucun contact affiché" : "Moyens de contact affichés" };
  }
}

export interface ConfigHealth {
  sections: number;
  sectionsOk: number;
  attention: number;
  switchesOn: number;
  switchesTotal: number;
}

export function configHealth(ctx: ConfigContext): ConfigHealth {
  const ids = CONFIG_SECTIONS.filter((s) => s.id !== "apercu").map((s) => s.id as ConfigWorkspaceId);
  const attention = configAttention(ctx);
  const switches = ids.flatMap((id) => sectionSwitches(ctx, id));
  return {
    sections: ids.length,
    sectionsOk: ids.filter((id) => !attention.some((a) => a.section === id)).length,
    attention: attention.length,
    switchesOn: switches.filter((x) => x.on).length,
    switchesTotal: switches.length,
  };
}

export interface SettingIndexEntry {
  label: string;
  section: ConfigWorkspaceId;
  anchor: string;
  keywords: string;
}

/** What « Rechercher un réglage » can find — the settings that exist for this tenant/user. */
export function settingsIndex(ctx: ConfigContext): SettingIndexEntry[] {
  const e = (label: string, section: ConfigWorkspaceId, anchor: string, keywords: string): SettingIndexEntry => ({ label, section, anchor, keywords });
  return [
    e("Nom, logo et coordonnées", "entreprise", "identite", "entreprise société nom logo adresse ville pays email téléphone contact devise"),
    e("Préfixe des numéros de commande", "commandes", "prefixe", "numérotation numéro préfixe cmd"),
    ...(ctx.imports.woocommerce !== null || ctx.imports.shopify !== null
      ? [e("Importer les commandes en « Nouvelle »", "commandes", "imports", "woocommerce shopify import boutique nouvelle confirmation")]
      : []),
    e("Vérification de l'emballage", "expedition", "emballage", "emballage scan vérification expédier préparation colis"),
    e("Transporteur par défaut", "expedition", "transporteur", "transporteur livraison ville ozon aramex"),
    ...(ctx.offlineSales ? [e("Prix modifiable par les vendeurs", "magasin", "prix-vendeurs", "magasin caisse vendeur prix remise")] : []),
    e("Seuil de stock faible", "stock", "seuil", "stock faible alerte seuil rupture"),
    e("Méthode de calcul du coût", "stock", "methode-cout", "coût achat moyen pondéré dernier manuel valorisation"),
    ...(ctx.canManageCost ? [e("Coût d'achat lors des transferts", "stock", "cout-transferts", "transfert coût achat destination emplacement")] : []),
    e("Contacts du support", "support", "contacts", "support aide whatsapp téléphone email horaires"),
  ];
}

const fold = (v: string) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Accent- and case-insensitive match on the label and keywords; every word must match. */
export function searchSettings(index: SettingIndexEntry[], query: string): SettingIndexEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return index.filter((x) => {
    const hay = fold(`${x.label} ${x.keywords}`);
    return words.every((w) => hay.includes(w));
  });
}
