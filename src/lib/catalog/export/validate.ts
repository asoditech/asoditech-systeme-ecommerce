import {
  activeVariations,
  attributeNames,
  EXPORT_PLATFORM_LABELS,
  isPublicImageUrl,
  type ExportPlatform,
  type ExportProduct,
} from "@/lib/catalog/export/model";

/**
 * Pre-export validation (docs/adr/0054). ERRORS block the download — the
 * file would be rejected by the platform or would create wrong/duplicate
 * products. WARNINGS are shown and must be acknowledged by the user, never
 * silently "fixed". The SAME function runs before download in the UI and
 * again inside the download route, so a crafted request cannot skip it.
 */

export interface ExportIssue {
  code: string;
  message: string;
  productId?: string;
  productName?: string;
}
export interface ExportValidation {
  errors: ExportIssue[];
  warnings: ExportIssue[];
}

export function validateExport(
  products: readonly ExportProduct[],
  platform: ExportPlatform,
  ctx: { storeConnected: boolean }
): ExportValidation {
  const errors: ExportIssue[] = [];
  const warnings: ExportIssue[] = [];
  const label = EXPORT_PLATFORM_LABELS[platform];
  const err = (p: ExportProduct | null, code: string, message: string) =>
    errors.push({ code, message, ...(p ? { productId: p.id, productName: p.name } : {}) });
  const warn = (p: ExportProduct | null, code: string, message: string) =>
    warnings.push({ code, message, ...(p ? { productId: p.id, productName: p.name } : {}) });

  if (products.length === 0) {
    err(null, "empty", "Aucun produit à exporter : sélectionnez au moins un produit.");
    return { errors, warnings };
  }

  const skus = new Map<string, string>();
  const claimSku = (p: ExportProduct, sku: string) => {
    const owner = skus.get(sku.toLowerCase());
    if (owner && owner !== p.name) err(p, "duplicate_sku", `SKU « ${sku} » en double dans l'export (aussi utilisé par « ${owner} »).`);
    else skus.set(sku.toLowerCase(), p.name);
  };
  const uncheckedCategories = new Set<string>();

  for (const p of products) {
    if (!p.name.trim()) err(p, "missing_name", "Nom du produit manquant.");
    if (!p.sku.trim()) err(p, "missing_sku", "SKU du produit manquant.");
    else claimSku(p, p.sku);

    const platformSource = platform === "woocommerce" ? "WOOCOMMERCE" : "SHOPIFY";
    if (p.source === platformSource) err(p, "already_on_platform", `Produit importé depuis ${label} : il existe déjà dans la boutique.`);
    if (p.publishedTo.includes(platform)) err(p, "already_published", `Produit déjà publié sur ${label} depuis ASODITECH.`);
    if (p.status !== "ACTIF") warn(p, "inactive", `Produit ${p.status === "ARCHIVE" ? "désactivé" : "brouillon"} : exporté en brouillon (non visible).`);

    const active = activeVariations(p);
    if (p.variations.length > 0 && active.length === 0) {
      err(p, "no_active_variation", "Produit à variations sans aucune variation active.");
    } else if (active.length === 0) {
      if (p.price === null || p.price <= 0) err(p, "missing_price", "Prix de vente manquant ou nul.");
      if (p.salePrice !== null && p.price !== null && p.salePrice >= p.price)
        warn(p, "sale_price_ignored", "Prix promotionnel ≥ prix de vente : ignoré.");
    } else {
      if (p.variations.length > active.length)
        warn(p, "inactive_variations_skipped", `${p.variations.length - active.length} variation(s) désactivée(s) non exportée(s).`);
      const names = attributeNames(p);
      if (platform === "shopify" && names.length > 3) {
        err(p, "too_many_options", `${names.length} attributs (${names.join(", ")}) : Shopify accepte au plus 3 options.`);
      }
      const combos = new Set<string>();
      for (const v of active) {
        if (!v.sku.trim()) err(p, "missing_variation_sku", "Une variation n'a pas de SKU.");
        else claimSku(p, v.sku);
        if (v.price === null || v.price <= 0) err(p, "missing_variation_price", `Variation ${v.sku} : prix manquant ou nul.`);
        const missing = names.filter((n) => !v.attributes[n]);
        if (missing.length) {
          if (platform === "shopify") err(p, "incomplete_variation", `Variation ${v.sku} : valeur manquante pour ${missing.join(", ")}.`);
          else warn(p, "incomplete_variation", `Variation ${v.sku} : valeur manquante pour ${missing.join(", ")} (« n'importe quelle valeur » dans WooCommerce).`);
        }
        const combo = names.map((n) => v.attributes[n] ?? "").join("|");
        if (combos.has(combo)) err(p, "duplicate_combination", `Deux variations ont la même combinaison (${combo.replace(/\|/g, " / ")}).`);
        combos.add(combo);
        if (v.imageUrl && !isPublicImageUrl(v.imageUrl)) warn(p, "private_image", `Image de la variation ${v.sku} non accessible publiquement : ignorée.`);
      }
    }

    const publicImages = p.images.filter((i) => isPublicImageUrl(i.url));
    if (p.images.length === 0) warn(p, "no_image", "Aucune image.");
    else if (publicImages.length < p.images.length)
      warn(p, "private_image", `${p.images.length - publicImages.length} image(s) sans URL publique http(s) : ignorée(s) (la plateforme doit pouvoir les télécharger).`);
    if (platform === "woocommerce" && publicImages.some((i) => i.url.includes(",")))
      warn(p, "image_url_comma", "Une URL d'image contient une virgule : ignorée (séparateur WooCommerce).");

    if (p.categoryPath.length === 0) {
      warn(p, "no_category", platform === "woocommerce" ? "Sans catégorie : importé dans « Non classé »." : "Sans catégorie : « Type » vide.");
    } else if (platform === "woocommerce" && p.categorySource !== "WOOCOMMERCE") {
      uncheckedCategories.add(p.categoryPath.join(" > "));
    }
  }

  for (const path of uncheckedCategories) {
    warn(
      null,
      "category_unverified",
      `Catégorie « ${path} » : non synchronisée depuis WooCommerce, elle ne peut pas être vérifiée — WooCommerce la créera à l'import si elle n'existe pas sous ce nom exact.`
    );
  }
  if (platform === "shopify") {
    warn(
      null,
      "shopify_category",
      "« Product category » (taxonomie standard Shopify) est laissé vide : la catégorie ASODITECH est placée dans « Type ». Choisissez la catégorie Shopify après l'import si nécessaire."
    );
  }
  warn(null, "no_stock", "Les quantités en stock ne sont pas exportées : ASODITECH reste la référence du stock.");
  if (ctx.storeConnected) {
    warn(
      null,
      "linked_on_sync",
      `Une boutique ${label} est connectée : après l'import, la synchronisation rattachera chaque produit à son produit ASODITECH par SKU (docs/adr/0055) — il devient alors un produit lié à ${label}, dont le nom, le prix et le statut sont gérés par la boutique. Ne modifiez pas les SKU avant la synchronisation.`
    );
  }
  return { errors, warnings };
}
