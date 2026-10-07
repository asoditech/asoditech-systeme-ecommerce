/**
 * Return dialogs (online order / in-store sale): a scanned article → +1
 * « revendable » on the matching line. Pure and client-safe; the code itself
 * is resolved on the server by the shared exact resolver
 * (src/lib/catalog/exact-code.ts, via resolveReturnCodeAction). This only
 * fills the form — the return actions keep every server-side guarantee
 * (lock, ceilings, idempotency, stock movements, audit).
 *
 * Never decides sellable vs damaged beyond « +1 revendable »: the operator
 * can still move units to « endommagé » by hand.
 */

export interface ReturnScanLine {
  id: string;
  label: string;
  productId: string | null;
  variationId: string | null;
  /** Still returnable on the server side (sold/shipped − already returned). */
  remaining: number;
  /** Quantities already typed in this dialog. */
  sellable: number;
  damaged: number;
}

export interface ScannedUnit {
  productId: string;
  variationId: string | null;
  label: string;
}

export type ReturnScanResult =
  | { ok: true; lineId: string; label: string; sellable: number }
  | { ok: false; error: string };

/** A variation matches only its own line; a simple product only a line without variation. */
function sameUnit(line: ReturnScanLine, unit: ScannedUnit): boolean {
  return unit.variationId ? line.variationId === unit.variationId : line.productId === unit.productId && !line.variationId;
}

export function applyReturnScan(
  lines: ReturnScanLine[],
  unit: ScannedUnit,
  source: "commande" | "vente"
): ReturnScanResult {
  const matching = lines.filter((l) => sameUnit(l, unit));
  if (matching.length === 0) {
    const sameProduct = unit.variationId && lines.some((l) => l.productId === unit.productId);
    return {
      ok: false,
      error: sameProduct
        ? `Cette variante (« ${unit.label} ») ne fait pas partie de cette ${source} — vérifiez la taille / la couleur.`
        : `« ${unit.label} » ne fait pas partie de cette ${source}.`,
    };
  }
  if (matching.every((l) => l.remaining <= 0)) {
    return { ok: false, error: `« ${matching[0].label} » a déjà été entièrement retourné.` };
  }
  const line = matching.find((l) => l.sellable + l.damaged < l.remaining);
  if (!line) {
    const max = matching.reduce((s, l) => s + l.remaining, 0);
    return { ok: false, error: `« ${matching[0].label} » : quantité maximale à retourner atteinte (${max}).` };
  }
  return { ok: true, lineId: line.id, label: line.label, sellable: line.sellable + 1 };
}
