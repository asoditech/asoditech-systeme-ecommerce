/**
 * P3 inspection screen — the operator's draft before submission. Pure and
 * client-safe. A scanned article is only MATCHED to its line (shared rules,
 * src/lib/returns/scan.ts); it counts for nothing until the operator
 * explicitly chooses its condition — never a silent « revendable » default.
 * The server re-validates everything (ceilings, ownership, idempotency).
 */
import { applyReturnScan, type ScannedUnit } from "@/lib/returns/scan";
import type { ReturnUnitCondition } from "@/lib/validation/return-receiving";

export interface InspectionDraftLine {
  orderItemId: string;
  label: string;
  productId: string | null;
  variationId: string | null;
  /** Still returnable on the server side (shipped − already returned). */
  remaining: number;
  sellable: number;
  damaged: number;
}

/** A scanned unit waiting for its condition. */
export interface PendingScan {
  orderItemId: string;
  label: string;
}

export type DraftResult = { ok: true; lines: InspectionDraftLine[] } | { ok: false; error: string };

export const RETURN_UNIT_CONDITION_LABELS: Record<ReturnUnitCondition, string> = {
  SELLABLE: "Revendable — remis en stock",
  DAMAGED: "Endommagé — non remis en stock",
};

/** Scan → the line it belongs to (or why not). Changes no quantity. */
export function matchScannedUnit(
  lines: readonly InspectionDraftLine[],
  unit: ScannedUnit
): { ok: true; pending: PendingScan } | { ok: false; error: string } {
  const r = applyReturnScan(
    lines.map((l) => ({
      id: l.orderItemId,
      label: l.label,
      productId: l.productId,
      variationId: l.variationId,
      remaining: l.remaining,
      sellable: l.sellable,
      damaged: l.damaged,
    })),
    unit,
    "commande"
  );
  return r.ok ? { ok: true, pending: { orderItemId: r.lineId, label: r.label } } : { ok: false, error: r.error };
}

/** Register ONE unit with the condition the operator chose. */
export function registerUnit(
  lines: readonly InspectionDraftLine[],
  orderItemId: string,
  condition: ReturnUnitCondition
): DraftResult {
  const line = lines.find((l) => l.orderItemId === orderItemId);
  if (!line) return { ok: false, error: "Article introuvable dans cette commande." };
  if (line.sellable + line.damaged >= line.remaining) {
    return { ok: false, error: `« ${line.label} » : quantité maximale à retourner atteinte (${line.remaining}).` };
  }
  return {
    ok: true,
    lines: lines.map((l) =>
      l.orderItemId !== orderItemId
        ? l
        : condition === "SELLABLE"
          ? { ...l, sellable: l.sellable + 1 }
          : { ...l, damaged: l.damaged + 1 }
    ),
  };
}

/** A typed quantity for one condition column — clamped to 0..what remains. */
export function setLineQuantity(
  lines: readonly InspectionDraftLine[],
  orderItemId: string,
  condition: ReturnUnitCondition,
  raw: string | number
): InspectionDraftLine[] {
  return lines.map((l) => {
    if (l.orderItemId !== orderItemId) return l;
    const n = Math.max(0, Math.trunc(Number(raw)) || 0);
    const other = condition === "SELLABLE" ? l.damaged : l.sellable;
    const value = Math.min(n, Math.max(0, l.remaining - other));
    return condition === "SELLABLE" ? { ...l, sellable: value } : { ...l, damaged: value };
  });
}

/** What the server receives: one entry per (line, condition) with a quantity > 0. */
export function draftToEntries(
  lines: readonly InspectionDraftLine[]
): { orderItemId: string; condition: ReturnUnitCondition; quantity: number }[] {
  const entries: { orderItemId: string; condition: ReturnUnitCondition; quantity: number }[] = [];
  for (const l of lines) {
    if (l.sellable > 0) entries.push({ orderItemId: l.orderItemId, condition: "SELLABLE", quantity: l.sellable });
    if (l.damaged > 0) entries.push({ orderItemId: l.orderItemId, condition: "DAMAGED", quantity: l.damaged });
  }
  return entries;
}

export function draftTotals(lines: readonly InspectionDraftLine[]): { sellable: number; damaged: number; notReceived: number } {
  let sellable = 0;
  let damaged = 0;
  let notReceived = 0;
  for (const l of lines) {
    sellable += l.sellable;
    damaged += l.damaged;
    notReceived += Math.max(0, l.remaining - l.sellable - l.damaged);
  }
  return { sellable, damaged, notReceived };
}
