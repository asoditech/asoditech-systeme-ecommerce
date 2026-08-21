import { z } from "zod";

export const orderStatusSchema = z.enum([
  "NOUVELLE",
  "CONFIRMEE",
  "EN_PREPARATION",
  "EXPEDIEE",
  "LIVREE",
  "ANNULEE",
  "RETOUR",
  "REMBOURSEE",
  "ECHEC",
]);
export type OrderStatusValue = z.infer<typeof orderStatusSchema>;

/**
 * Explicit, code-enforced state machine — see docs/adr/0002-domain-model.md.
 * ANNULEE/REMBOURSEE are terminal. A shipment carrier failure moves EXPEDIEE
 * -> ECHEC, which staff can retry back to EN_PREPARATION.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatusValue, OrderStatusValue[]> = {
  NOUVELLE: ["CONFIRMEE", "ANNULEE"],
  CONFIRMEE: ["EN_PREPARATION", "ANNULEE"],
  EN_PREPARATION: ["EXPEDIEE", "ANNULEE"],
  EXPEDIEE: ["LIVREE", "ECHEC", "RETOUR"],
  LIVREE: ["RETOUR"],
  ECHEC: ["EN_PREPARATION", "ANNULEE"],
  RETOUR: ["REMBOURSEE"],
  ANNULEE: [],
  REMBOURSEE: [],
};

export function canTransitionOrderStatus(from: OrderStatusValue, to: OrderStatusValue): boolean {
  if (from === to) return false;
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

export const orderPaymentStatusSchema = z.enum([
  "EN_ATTENTE",
  "PAYE",
  "PARTIELLEMENT_PAYE",
  "ECHEC",
  "REMBOURSE",
]);

export const paymentMethodSchema = z.enum([
  "PAIEMENT_LIVRAISON",
  "VIREMENT_BANCAIRE",
  "CARTE_BANCAIRE",
  "MOBILE_MONEY",
  "AUTRE",
]);

export const orderItemInputSchema = z.object({
  productId: z.string().min(1).nullish(),
  variationId: z.string().min(1).nullish(),
  quantity: z.coerce.number().int().min(1, "La quantité doit être au moins 1."),
  unitPrice: z.coerce.number().min(0, "Le prix unitaire doit être positif ou nul."),
  discount: z.coerce.number().min(0).default(0),
});

export const createOrderSchema = z.object({
  customerId: z.string().min(1, "Le client est requis."),
  paymentMethod: paymentMethodSchema,
  shippingCost: z.coerce.number().min(0).default(0),
  discountTotal: z.coerce.number().min(0).default(0),
  currency: z.string().length(3).default("MAD"),
  notes: z.string().trim().max(5000).nullish().or(z.literal("")),
  internalNotes: z.string().trim().max(5000).nullish().or(z.literal("")),
  shippingAddressLine1: z.string().trim().max(255).nullish().or(z.literal("")),
  shippingAddressLine2: z.string().trim().max(255).nullish().or(z.literal("")),
  shippingCity: z.string().trim().max(120).nullish().or(z.literal("")),
  shippingRegion: z.string().trim().max(120).nullish().or(z.literal("")),
  shippingCountry: z.string().trim().max(120).nullish().or(z.literal("")),
  shippingPhone: z.string().trim().max(30).nullish().or(z.literal("")),
  items: z.array(orderItemInputSchema).min(1, "Ajoutez au moins un article à la commande."),
});

export const updateOrderStatusSchema = z.object({
  id: z.string().min(1),
  status: orderStatusSchema,
  note: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export const updateOrderPaymentStatusSchema = z.object({
  id: z.string().min(1),
  paymentStatus: orderPaymentStatusSchema,
});

export const cancelOrderSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export const createRefundSchema = z.object({
  orderId: z.string().min(1),
  amount: z.coerce.number().positive("Le montant du remboursement doit être positif."),
  reason: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export const refundStatusSchema = z.enum(["EN_ATTENTE", "APPROUVE", "REJETE", "COMPLETE"]);

export const updateRefundStatusSchema = z.object({
  id: z.string().min(1),
  status: refundStatusSchema,
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
