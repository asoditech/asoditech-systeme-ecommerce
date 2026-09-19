import { z } from "zod";
import { cashPaymentMethodSchema } from "@/lib/validation/purchases";

/**
 * In-store sales — docs/adr/0040. An offline Sale completes ATOMICALLY (lines,
 * payments and the canonical VENTE movements in one transaction): there is no
 * draft, no reservation and no carrier step.
 */

const saleLineSchema = z
  .object({
    productId: z.string().min(1).nullish(),
    variationId: z.string().min(1).nullish(),
    quantity: z.coerce.number().int().positive("La quantité doit être au moins 1."),
    // OPTIONAL: omitted → the server uses the catalogue price. A value that
    // differs from it requires `sales.override_price` (checked server-side).
    unitPrice: z.coerce.number().min(0).nullish(),
    discount: z.coerce.number().min(0).default(0),
  })
  .refine((l) => Boolean(l.productId) !== Boolean(l.variationId), {
    message: "Chaque ligne doit référencer soit un produit, soit une variation.",
    path: ["productId"],
  });

const salePaymentSchema = z.object({
  method: cashPaymentMethodSchema,
  amount: z.coerce.number().positive("Le montant du paiement doit être supérieur à 0."),
  reference: z.string().trim().max(100).nullish().or(z.literal("")),
});

export const createSaleSchema = z.object({
  salesChannelId: z.string().min(1, "Le canal de vente est requis."),
  warehouseId: z.string().min(1, "L'emplacement de vente est requis."),
  // Client-generated per submit attempt (one per sale form): a retried or
  // double-clicked submit carries the same key and creates ONE sale.
  idempotencyKey: z.string().trim().min(8, "Clé d'idempotence requise.").max(100),
  customerId: z.string().min(1).nullish().or(z.literal("")),
  customerLabel: z.string().trim().max(200).nullish().or(z.literal("")),
  notes: z.string().trim().max(2000).nullish().or(z.literal("")),
  lines: z.array(saleLineSchema).min(1, "Ajoutez au moins un article à la vente."),
  payments: z.array(salePaymentSchema).max(10).default([]),
});
export type CreateSaleInput = z.input<typeof createSaleSchema>;

export const saleReturnLineSchema = z
  .object({
    saleLineId: z.string().min(1),
    quantitySellable: z.coerce.number().int().min(0).default(0),
    quantityDamaged: z.coerce.number().int().min(0).default(0),
  })
  .refine((l) => l.quantitySellable + l.quantityDamaged > 0, {
    message: "Indiquez une quantité revendable ou endommagée.",
    path: ["quantitySellable"],
  });

export const createSaleReturnSchema = z
  .object({
    saleId: z.string().min(1),
    idempotencyKey: z.string().trim().min(8).max(100),
    lines: z.array(saleReturnLineSchema).min(1, "Sélectionnez au moins un article retourné."),
    refundAmount: z.coerce.number().min(0).default(0),
    refundMethod: cashPaymentMethodSchema.nullish(),
    note: z.string().trim().max(2000).nullish().or(z.literal("")),
  })
  .refine((r) => r.refundAmount === 0 || Boolean(r.refundMethod), {
    message: "Indiquez le mode de remboursement.",
    path: ["refundMethod"],
  });
export type CreateSaleReturnInput = z.input<typeof createSaleReturnSchema>;

export const lookupForSaleSchema = z.object({
  query: z.string().trim().min(1).max(100),
  salesChannelId: z.string().min(1),
  warehouseId: z.string().min(1),
});
