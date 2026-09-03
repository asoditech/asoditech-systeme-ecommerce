import { z } from "zod";

/**
 * Stocktake validation + state machine — Phase 32c
 * (docs/adr/0021-stocktaking.md).
 *
 * Lifecycle (mirrors ORDER_STATUS_TRANSITIONS / TRANSFER_STATUS_TRANSITIONS):
 *   EN_COURS --finalize--> CLOTURE   (terminal)
 *   EN_COURS --cancel----> ANNULE    (terminal)
 */
export const stocktakeStatusSchema = z.enum(["EN_COURS", "CLOTURE", "ANNULE"]);
export type StocktakeStatusValue = z.infer<typeof stocktakeStatusSchema>;

export const STOCKTAKE_STATUS_TRANSITIONS: Record<StocktakeStatusValue, StocktakeStatusValue[]> = {
  EN_COURS: ["CLOTURE", "ANNULE"],
  CLOTURE: [],
  ANNULE: [],
};

export function canTransitionStocktakeStatus(from: StocktakeStatusValue, to: StocktakeStatusValue): boolean {
  if (from === to) return false;
  return STOCKTAKE_STATUS_TRANSITIONS[from].includes(to);
}

export const createStocktakeSessionSchema = z.object({
  warehouseId: z.string().min(1, "L'entrepôt est requis."),
  notes: z.string().trim().max(5000).nullish().or(z.literal("")),
});
export type CreateStocktakeSessionInput = z.infer<typeof createStocktakeSessionSchema>;

/**
 * Bulk count entry. `countedQuantity` is either an integer ≥ 0 (the count)
 * or explicit `null` — `null` means "clear this line's count" (it reverts
 * to uncounted and is skipped at finalize, and is also how an operator
 * abandons a stale line). `.nullable()` short-circuits on `null` before
 * the `coerce`, so `null` is never coerced to 0.
 */
export const updateStocktakeCountsSchema = z.object({
  id: z.string().min(1),
  counts: z
    .array(
      z.object({
        lineId: z.string().min(1),
        countedQuantity: z.coerce
          .number()
          .int("La quantité comptée doit être un nombre entier.")
          .min(0, "La quantité comptée ne peut pas être négative.")
          .nullable(),
      })
    )
    .min(1, "Aucun comptage à enregistrer."),
});
export type UpdateStocktakeCountsInput = z.infer<typeof updateStocktakeCountsSchema>;

export const finalizeStocktakeSessionSchema = z.object({ id: z.string().min(1) });
export const cancelStocktakeSessionSchema = z.object({ id: z.string().min(1) });
