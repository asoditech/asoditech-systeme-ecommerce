import "server-only";

import { lookupSellableUnits, type SellableUnit } from "@/lib/catalog/lookup";
import type { prisma, PrismaTransactionClient } from "@/lib/prisma";

/**
 * A scanned / typed code → ONE exact catalogue unit, for workflows that must
 * verify a physical article (packing today; returns next). Same lookup as the
 * sale/reception search (src/lib/catalog/lookup.ts), but only an EXACT match
 * counts: the barcode, a variation SKU, or a simple product's SKU — never a
 * name or partial match, and never a code that stands for several units
 * (e.g. a variable product's parent SKU). Inactive/archived units still
 * resolve: an article already ordered must stay verifiable.
 */

export const EXACT_CODE_MESSAGES = {
  notFound: "Code inconnu : aucun produit ne correspond exactement à ce code-barres ou SKU.",
  ambiguous: "Code ambigu : il correspond à plusieurs articles (ex. le SKU du produit parent). Scannez le code de la variante.",
} as const;

export type ExactCodeResult =
  | { ok: true; unit: SellableUnit }
  | { ok: false; reason: "not_found" | "ambiguous"; error: string };

type Db = typeof prisma | PrismaTransactionClient;

export async function resolveExactCode(db: Db, code: string): Promise<ExactCodeResult> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, reason: "not_found", error: EXACT_CODE_MESSAGES.notFound };
  const units = (await lookupSellableUnits(db, trimmed, { onlyActive: false, limit: 5 })).filter(
    (u) => u.matchedBy === "barcode" || u.matchedBy === "sku"
  );
  if (units.length === 0) return { ok: false, reason: "not_found", error: EXACT_CODE_MESSAGES.notFound };
  if (units.length > 1) return { ok: false, reason: "ambiguous", error: EXACT_CODE_MESSAGES.ambiguous };
  return { ok: true, unit: units[0] };
}
