import "server-only";

import { EXPORT_PLATFORMS, exportFilename, toImportCsv, type ExportPlatform } from "@/lib/catalog/export/model";
import { buildWooCommerceCsv } from "@/lib/catalog/export/woocommerce";
import { buildShopifyCsv } from "@/lib/catalog/export/shopify";
import { validateExport, type ExportValidation } from "@/lib/catalog/export/validate";
import { isStoreConnected, loadExportProducts } from "@/lib/catalog/export/load";

/** Hard cap per file — a supplier batch is tens of products, not the whole catalogue in one go. */
export const EXPORT_MAX_PRODUCTS = 500;

export function parseExportPlatform(value: unknown): ExportPlatform | null {
  return typeof value === "string" && (EXPORT_PLATFORMS as readonly string[]).includes(value) ? (value as ExportPlatform) : null;
}

export interface PreparedExport {
  validation: ExportValidation;
  productCount: number;
  rowCount: number;
  filename: string;
  csv: string | null;
}

/**
 * Load (tenant-scoped) → validate → build. The ONE path used by the
 * validation action and the download route, so the file is always the one
 * that was validated. Ids that do not resolve in this tenant make the whole
 * export fail — never a silently partial file.
 */
export async function prepareProductExport(platform: ExportPlatform, ids: readonly string[]): Promise<PreparedExport> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const filename = exportFilename(platform);
  if (unique.length > EXPORT_MAX_PRODUCTS) {
    return {
      validation: { errors: [{ code: "too_many", message: `Au plus ${EXPORT_MAX_PRODUCTS} produits par export (${unique.length} sélectionnés).` }], warnings: [] },
      productCount: unique.length,
      rowCount: 0,
      filename,
      csv: null,
    };
  }
  const [products, storeConnected] = await Promise.all([loadExportProducts(unique), isStoreConnected(platform)]);
  const validation = validateExport(products, platform, { storeConnected });
  if (products.length !== unique.length) {
    validation.errors.unshift({ code: "not_found", message: `${unique.length - products.length} produit(s) introuvable(s).` });
  }
  if (validation.errors.length > 0) return { validation, productCount: products.length, rowCount: 0, filename, csv: null };
  const { headers, rows } = platform === "woocommerce" ? buildWooCommerceCsv(products) : buildShopifyCsv(products);
  return { validation, productCount: products.length, rowCount: rows.length, filename, csv: toImportCsv(headers, rows) };
}
