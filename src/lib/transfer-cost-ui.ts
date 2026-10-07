/**
 * Transfer destination purchase cost — the client-side rules of the transfer
 * form (pure, client-safe). The server re-validates everything
 * (src/actions/transfers.ts: tenant setting + finance.view + >= 0).
 */

export const TRANSFER_COST_LABEL = "Coût d'achat à destination";
export const TRANSFER_COST_NOTE =
  "Ce coût concerne le coût d'achat du produit à l'emplacement de destination. Il ne modifie pas le prix de vente.";

/** The cost field is shown only when the tenant setting is on AND the user may see financial data. */
export function canEnterTransferCost(settingEnabled: boolean, canViewFinance: boolean): boolean {
  return settingEnabled && canViewFinance;
}

/**
 * Parses what the user typed: "" → null (no cost / clear), "110", "110.5",
 * "110,50" → a number. Non-negative, at most 2 decimals (the column is
 * Decimal(12,2) — never silently rounded), at most 10 integer digits.
 */
export function parseTransferCostInput(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const v = raw.trim().replace(",", ".");
  if (v === "") return { ok: true, value: null };
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(v)) {
    return { ok: false, error: "Coût d'achat à destination invalide : un nombre positif ou nul, 2 décimales au plus." };
  }
  return { ok: true, value: Number(v) };
}

export interface TransferFormLine {
  productId: string | null;
  variationId: string | null;
  quantitySent: number;
  /** What the cost field holds (only meaningful when the field is shown). */
  cost?: string;
}

/**
 * The lines sent to create/update. Field hidden → no `destinationUnitCost`
 * key at all (« inchangé » on a draft edit: a recorded cost is kept). Field
 * shown → `null` for an empty field (clears) or the number (sets/replaces).
 */
export function buildTransferLinesPayload(
  lines: TransferFormLine[],
  costEntry: boolean
):
  | { ok: true; lines: { productId: string | null; variationId: string | null; quantitySent: number; destinationUnitCost?: number | null }[] }
  | { ok: false; error: string } {
  const out = [];
  for (const l of lines) {
    const base = { productId: l.variationId ? null : l.productId, variationId: l.variationId, quantitySent: l.quantitySent };
    if (!costEntry) {
      out.push(base);
      continue;
    }
    const parsed = parseTransferCostInput(l.cost ?? "");
    if (!parsed.ok) return parsed;
    out.push({ ...base, destinationUnitCost: parsed.value });
  }
  return { ok: true, lines: out };
}
