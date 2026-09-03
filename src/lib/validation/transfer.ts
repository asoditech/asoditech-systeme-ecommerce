import { z } from "zod";

/**
 * Stock transfer validation + state machine — Phase 32b
 * (docs/adr/0020-stock-transfers.md).
 *
 * Lifecycle (mirrors ORDER_STATUS_TRANSITIONS):
 *   BROUILLON --dispatch--> EN_TRANSIT --receive--> RECU   (terminal)
 *   BROUILLON --cancel----> ANNULE                          (terminal)
 */
export const transferStatusSchema = z.enum(["BROUILLON", "EN_TRANSIT", "RECU", "ANNULE"]);
export type TransferStatusValue = z.infer<typeof transferStatusSchema>;

export const TRANSFER_STATUS_TRANSITIONS: Record<TransferStatusValue, TransferStatusValue[]> = {
  BROUILLON: ["EN_TRANSIT", "ANNULE"],
  EN_TRANSIT: ["RECU"],
  RECU: [],
  ANNULE: [],
};

export function canTransitionTransferStatus(from: TransferStatusValue, to: TransferStatusValue): boolean {
  if (from === to) return false;
  return TRANSFER_STATUS_TRANSITIONS[from].includes(to);
}

/** One draft line — exactly one of productId / variationId, enforced at the
 * application level (see the schema comment on StockTransferLine). */
const transferLineInputSchema = z
  .object({
    productId: z.string().min(1).nullish(),
    variationId: z.string().min(1).nullish(),
    quantitySent: z.coerce.number().int().positive("La quantité doit être au moins 1."),
  })
  .refine((line) => Boolean(line.productId) !== Boolean(line.variationId), {
    message: "Chaque ligne doit référencer soit un produit, soit une variation.",
    path: ["productId"],
  });

export const createStockTransferSchema = z
  .object({
    sourceWarehouseId: z.string().min(1, "L'entrepôt source est requis."),
    destinationWarehouseId: z.string().min(1, "L'entrepôt de destination est requis."),
    notes: z.string().trim().max(5000).nullish().or(z.literal("")),
    lines: z.array(transferLineInputSchema).min(1, "Ajoutez au moins une ligne au transfert."),
  })
  .refine((t) => t.sourceWarehouseId !== t.destinationWarehouseId, {
    message: "La source et la destination doivent être différentes.",
    path: ["destinationWarehouseId"],
  });
export type CreateStockTransferInput = z.infer<typeof createStockTransferSchema>;

/** Draft edit — only lines + notes; source/destination are immutable. */
export const updateStockTransferDraftSchema = z.object({
  id: z.string().min(1),
  notes: z.string().trim().max(5000).nullish().or(z.literal("")),
  lines: z.array(transferLineInputSchema).min(1, "Un transfert doit garder au moins une ligne."),
});
export type UpdateStockTransferDraftInput = z.infer<typeof updateStockTransferDraftSchema>;

export const dispatchStockTransferSchema = z.object({ id: z.string().min(1) });
export const cancelStockTransferSchema = z.object({ id: z.string().min(1) });

export const receiveStockTransferSchema = z.object({
  id: z.string().min(1),
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        // 0 <= quantityReceived <= quantitySent (upper bound checked
        // server-side against the persisted line; also a DB CHECK).
        quantityReceived: z.coerce.number().int().min(0, "La quantité reçue ne peut pas être négative."),
      })
    )
    .min(1),
});
export type ReceiveStockTransferInput = z.infer<typeof receiveStockTransferSchema>;
