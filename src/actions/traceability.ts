"use server";

import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { listSellableUnits } from "@/lib/catalog/lookup";
import { lookupQuerySchema } from "@/lib/validation/catalog";
import { findTraceUnits } from "@/lib/queries/traceability";

/** What the « Traçabilité » picker needs to show and pick an article — no price, no cost. */
export interface TracePickerUnit {
  productId: string;
  variationId: string | null;
  name: string;
  variantLabel: string | null;
  sku: string;
  primaryBarcode: string | null;
  categoryName: string | null;
  status: "ACTIF" | "BROUILLON" | "ARCHIVE";
}

/**
 * The « Traçabilité » product picker (src/components/traceability/trace-unit-picker.tsx).
 * Same permission as the page (`traceability.view`, itself only effective when
 * the tenant's business mode enables traceability) and the SAME search the page
 * runs on `?q=` (findTraceUnits: label QR → barcode → SKU/reference → name,
 * archived included, at most 15), so what the picker offers is exactly what
 * the page can open. An empty query lists the first 15 active articles by name.
 * Tenant-scoped through `prisma`; read-only.
 */
export async function lookupTraceUnitsAction(input: { query: string }): Promise<TracePickerUnit[]> {
  await requirePermissionForAction("traceability.view");
  const parsed = lookupQuerySchema.safeParse(input);
  if (!parsed.success) return [];
  const units = parsed.data.query
    ? await findTraceUnits(parsed.data.query)
    : await listSellableUnits(prisma, { onlyActive: true, limit: 15 });
  return units.map((u) => ({
    productId: u.productId,
    variationId: u.variationId,
    name: u.name,
    variantLabel: u.variantLabel,
    sku: u.sku,
    primaryBarcode: u.primaryBarcode,
    categoryName: u.categoryName,
    status: u.status,
  }));
}
