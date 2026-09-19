import { z } from "zod";

/**
 * Suppliers, receptions and supplier payments — docs/adr/0040.
 *
 * Reception lifecycle:
 *   BROUILLON --validate--> VALIDEE   (terminal; the canonical stock movement is written)
 *   BROUILLON --cancel----> ANNULEE   (terminal; no stock effect)
 * A validated reception is IMMUTABLE: it is never edited or deleted (unlike a
 * POS that lets you edit a received purchase). Correcting one is a separate,
 * explicit future document (a supplier return / reversal), not an edit.
 */

export const cashPaymentMethodSchema = z.enum(["ESPECES", "CARTE", "VIREMENT", "CHEQUE", "AUTRE"]);

const optionalText = (max: number) => z.string().trim().max(max).nullish().or(z.literal(""));

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2, "Le nom du fournisseur est requis.").max(200),
  phone: optionalText(50),
  email: z.string().trim().email("E-mail invalide.").max(200).nullish().or(z.literal("")),
  address: optionalText(500),
  city: optionalText(100),
  notes: optionalText(5000),
});
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

export const updateSupplierSchema = createSupplierSchema.extend({
  id: z.string().min(1),
  isActive: z.boolean().default(true),
});
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

/** One reception line — exactly one of productId / variationId (a sellable unit). */
const receptionLineSchema = z
  .object({
    productId: z.string().min(1).nullish(),
    variationId: z.string().min(1).nullish(),
    quantity: z.coerce.number().int().positive("La quantité doit être au moins 1."),
    unitCost: z.coerce.number().min(0, "Le prix d'achat doit être positif ou nul."),
  })
  .refine((l) => Boolean(l.productId) !== Boolean(l.variationId), {
    message: "Chaque ligne doit référencer soit un produit, soit une variation.",
    path: ["productId"],
  });

const receptionBaseSchema = z.object({
  supplierId: z.string().min(1, "Le fournisseur est requis."),
  warehouseId: z.string().min(1, "L'emplacement de destination est requis."),
  receptionDate: z.coerce.date().optional(),
  supplierReference: optionalText(100),
  notes: optionalText(5000),
  lines: z.array(receptionLineSchema).min(1, "Ajoutez au moins une ligne à la réception."),
});

export const createReceptionSchema = receptionBaseSchema;
export type CreateReceptionInput = z.input<typeof createReceptionSchema>;

/** Draft edit — every field is editable while the reception is still a draft. */
export const updateReceptionDraftSchema = receptionBaseSchema.extend({ id: z.string().min(1) });
export type UpdateReceptionDraftInput = z.input<typeof updateReceptionDraftSchema>;

export const receptionIdSchema = z.object({ id: z.string().min(1) });

export const supplierPaymentSchema = z.object({
  supplierId: z.string().min(1),
  // Optional: settle ONE (validated) reception, or leave on the supplier's account.
  receptionId: z.string().min(1).nullish().or(z.literal("")),
  amount: z.coerce.number().positive("Le montant doit être supérieur à 0."),
  method: cashPaymentMethodSchema.default("ESPECES"),
  paidAt: z.coerce.date().optional(),
  reference: optionalText(100),
  notes: optionalText(2000),
});
export type SupplierPaymentInput = z.input<typeof supplierPaymentSchema>;
