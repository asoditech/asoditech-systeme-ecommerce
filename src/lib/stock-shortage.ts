import type { ActionResult } from "@/actions/types";

/**
 * Client-safe reading of a confirmation refused for stock (P2) — the shape
 * `stockShortageResult` (src/lib/stock-validation.ts) returns through the
 * existing `ActionResult.fieldErrors`. The token is opaque here: the server
 * re-verifies everything when it comes back.
 */
export interface StockShortage {
  lines: string[];
  canOverride: boolean;
  token: string | null;
}

export function stockShortageOf(result: ActionResult<unknown>): StockShortage | null {
  if (result.ok || !result.fieldErrors?.stockShortage?.length) return null;
  const canOverride = result.fieldErrors.canOverride?.[0] === "true";
  return {
    lines: result.fieldErrors.stockShortage,
    canOverride,
    token: canOverride ? (result.fieldErrors.stockOverrideToken?.[0] ?? null) : null,
  };
}

export const STOCK_OVERRIDE_REASON_LIMITS = { min: 3, max: 500 } as const;

/** What the order page knows about a NOUVELLE order's stock before confirming (P2). */
export interface ConfirmationStockFlags {
  /** A tracked row at the fulfilment warehouse does not cover the order. */
  insufficient: boolean;
  /** A line has no stock row there, or its product's stock tracking is off. */
  untracked: boolean;
}

/** Warning lines shown in the « → Confirmée » confirmation dialog; empty when nothing to say. */
export function confirmationStockNotice(flags: ConfirmationStockFlags | null | undefined): string[] {
  if (!flags) return [];
  const lines: string[] = [];
  if (flags.insufficient) {
    lines.push(
      "Stock insuffisant à l'emplacement de préparation pour au moins un article : la confirmation sera refusée, sauf validation motivée d'un responsable."
    );
  }
  if (flags.untracked) {
    lines.push(
      "Stock non suivi pour au moins un article à cet emplacement : aucune vérification de disponibilité n'est faite pour ces lignes."
    );
  }
  return lines;
}
