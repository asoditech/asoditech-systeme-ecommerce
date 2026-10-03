"use server";

import { requirePermissionForAction } from "@/lib/auth/guards";
import { parseExportPlatform, prepareProductExport } from "@/lib/catalog/export/service";
import type { ExportValidation } from "@/lib/catalog/export/validate";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * Pre-export check shown before the download (docs/adr/0054). Same
 * permission and the same `prepareProductExport` as the download route.
 */
export async function validateProductExportAction(input: {
  platform: string;
  ids: string[];
}): Promise<ActionResult<{ validation: ExportValidation; productCount: number; rowCount: number; filename: string }>> {
  await requirePermissionForAction("products.edit");
  const platform = parseExportPlatform(input.platform);
  if (!platform) return actionError("Plateforme inconnue.");
  if (!Array.isArray(input.ids)) return actionError("Sélection invalide.");
  const prepared = await prepareProductExport(platform, input.ids);
  return actionOk({ validation: prepared.validation, productCount: prepared.productCount, rowCount: prepared.rowCount, filename: prepared.filename });
}
