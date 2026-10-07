import type { OrderStatus, Prisma } from "@prisma/client";

/**
 * Packing verification — pure, client-safe rules (« Emballage » = the existing
 * OrderStatus EN_PREPARATION; no new status). The server actions
 * (src/actions/packing.ts) and the shipment gate use these; the packing screen
 * uses the same functions for its live progress, but every final decision is
 * re-computed on the server.
 */

/** Order fields that clear a previous packing verification. */
export const PACKING_CLEARED = { packedAt: null, packedById: null, packingMethod: null } as const;

/** Moving an order back to « Nouvelle » or to « Annulée » invalidates its packing. ECHEC → EN_PREPARATION keeps it (re-shipping the same parcel). */
export function packingResetFor(status: OrderStatus): typeof PACKING_CLEARED | Record<string, never> {
  return status === "NOUVELLE" || status === "ANNULEE" ? PACKING_CLEARED : {};
}

// ---------------------------------------------------------------------------
// Shipment eligibility
// ---------------------------------------------------------------------------

/** Today's rule (setting off) — kept identical to SHIPPABLE_ORDER_STATUSES in src/lib/delivery.ts. */
const SHIPPABLE_WITHOUT_PACKING: OrderStatus[] = ["CONFIRMEE", "EN_PREPARATION", "ECHEC"];
/** With « Vérification de l'emballage obligatoire »: packed (EN_PREPARATION) or a failed delivery being re-shipped. */
const SHIPPABLE_WITH_PACKING: OrderStatus[] = ["EN_PREPARATION", "ECHEC"];

export const PACKING_NOT_VERIFIED_MESSAGE = "L'emballage de cette commande n'a pas encore été vérifié.";
const NOT_SHIPPABLE_MESSAGE = "Cette commande n'est pas dans un statut permettant de créer une expédition.";

/** The order part of « À expédier » (the "no active shipment" part is unchanged, see listOrdersAwaitingShipment). */
export function shippableOrderWhere(packingRequired: boolean): Prisma.OrderWhereInput {
  return packingRequired
    ? { status: { in: SHIPPABLE_WITH_PACKING }, packedAt: { not: null } }
    : { status: { in: SHIPPABLE_WITHOUT_PACKING } };
}

/** null = may be shipped; otherwise the French reason. Same rule as `shippableOrderWhere`. */
export function shippableOrderProblem(
  order: { status: OrderStatus; packedAt: Date | null },
  packingRequired: boolean
): string | null {
  if (!packingRequired) return SHIPPABLE_WITHOUT_PACKING.includes(order.status) ? null : NOT_SHIPPABLE_MESSAGE;
  if (!SHIPPABLE_WITH_PACKING.includes(order.status)) {
    return order.status === "CONFIRMEE" ? PACKING_NOT_VERIFIED_MESSAGE : NOT_SHIPPABLE_MESSAGE;
  }
  return order.packedAt ? null : PACKING_NOT_VERIFIED_MESSAGE;
}

// ---------------------------------------------------------------------------
// Packing lines and scan verdicts
// ---------------------------------------------------------------------------

/** One unit to pack: a variation, or a simple product (no variation). */
export const packingKey = (u: { productId: string | null; variationId: string | null }) =>
  u.variationId ? `v:${u.variationId}` : `p:${u.productId}`;

export interface PackingLine {
  key: string;
  label: string;
  sku: string;
  required: number;
}

/** The order's lines grouped by unit (the same variation on two lines = one line to pack, quantities summed). Lines with no catalogue link can only be validated manually. */
export function packingLines(
  items: { productId: string | null; variationId: string | null; nameSnapshot: string; skuSnapshot: string; quantity: number; label?: string }[]
): PackingLine[] {
  const byKey = new Map<string, PackingLine>();
  for (const [i, item] of items.entries()) {
    const key = item.productId || item.variationId ? packingKey(item) : `x:${i}`;
    const line = byKey.get(key);
    if (line) line.required += item.quantity;
    else byKey.set(key, { key, label: item.label ?? item.nameSnapshot, sku: item.skuSnapshot, required: item.quantity });
  }
  return [...byKey.values()];
}

export type ScanVerdict = { ok: true; key: string } | { ok: false; error: string };

/** Unknown / ambiguous codes: EXACT_CODE_MESSAGES (src/lib/catalog/exact-code.ts). */
export const PACKING_MESSAGES = {
  notInOrder: "Ce produit ne fait pas partie de cette commande.",
  complete: "Quantité déjà complète.",
} as const;

/** A resolved scan against the lines and the units already counted (scan or manual). */
export function scanVerdict(lines: PackingLine[], counts: Record<string, number>, key: string): ScanVerdict {
  const line = lines.find((l) => l.key === key);
  if (!line) return { ok: false, error: PACKING_MESSAGES.notInOrder };
  if ((counts[key] ?? 0) >= line.required) return { ok: false, error: PACKING_MESSAGES.complete };
  return { ok: true, key };
}

/** Units counted per line: scanned units, plus the full quantity of each manually validated line. */
export function packingCounts(lines: PackingLine[], scannedKeys: string[], manualKeys: string[] = []): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of scannedKeys) counts[key] = (counts[key] ?? 0) + 1;
  for (const key of manualKeys) {
    const line = lines.find((l) => l.key === key);
    if (line) counts[key] = line.required;
  }
  return counts;
}

/** Complete = every line exactly at its quantity, nothing extra. */
export function isPackingComplete(lines: PackingLine[], counts: Record<string, number>): boolean {
  return lines.length > 0 && lines.every((l) => (counts[l.key] ?? 0) === l.required) && Object.keys(counts).every((k) => lines.some((l) => l.key === k));
}
