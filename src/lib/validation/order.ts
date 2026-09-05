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

/** Where a manually-created order actually came from — see OrderChannel's
 * own doc comment in schema.prisma. */
export const orderChannelSchema = z.enum(["TELEPHONE", "WHATSAPP", "INSTAGRAM", "FACEBOOK", "SITE_WEB", "AUTRE"]);

export const orderItemInputSchema = z
  .object({
    productId: z.string().min(1).nullish(),
    variationId: z.string().min(1).nullish(),
    quantity: z.coerce.number().int().min(1, "La quantité doit être au moins 1."),
    unitPrice: z.coerce.number().min(0, "Le prix unitaire doit être positif ou nul."),
    discount: z.coerce.number().min(0).default(0),
  })
  // A per-line discount larger than the line's own gross amount would make
  // that line's total negative — never a legitimate order, always a
  // data-entry mistake. Reject it here rather than silently clamping, so
  // staff notice and correct the discount instead of getting a total that
  // doesn't match what they typed.
  .refine((item) => item.discount <= item.unitPrice * item.quantity, {
    message: "La remise ne peut pas dépasser le montant de la ligne.",
    path: ["discount"],
  });

export const createOrderSchema = z.object({
  customerId: z.string().min(1, "Le client est requis."),
  // Optional operator override of the fulfilment warehouse (Phase 32b).
  // Omitted / null → createOrderAction uses getDefaultWarehouseId(). When
  // present it must be an existing active warehouse (validated server-side).
  fulfillmentWarehouseId: z.string().min(1).nullish().or(z.literal("")),
  paymentMethod: paymentMethodSchema,
  channel: orderChannelSchema.default("TELEPHONE"),
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
})
  // Order-level discount is on top of each line's own discount — together
  // they must never exceed what the line items are actually worth, or the
  // order total goes negative. See createOrderAction for how subtotal is
  // computed server-side from these same items.
  .refine(
    (order) => {
      const subtotal = order.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      const itemsDiscount = order.items.reduce((sum, i) => sum + i.discount, 0);
      return subtotal - itemsDiscount - order.discountTotal + order.shippingCost >= 0;
    },
    { message: "La remise dépasse le total de la commande.", path: ["discountTotal"] }
  );

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
export type RefundStatusValue = z.infer<typeof refundStatusSchema>;

/** Terminal: REJETE, COMPLETE. Added during the A–G audit — see docs/adr/0002. */
export const REFUND_STATUS_TRANSITIONS: Record<RefundStatusValue, RefundStatusValue[]> = {
  EN_ATTENTE: ["APPROUVE", "REJETE"],
  APPROUVE: ["COMPLETE", "REJETE"],
  REJETE: [],
  COMPLETE: [],
};

export function canTransitionRefundStatus(from: RefundStatusValue, to: RefundStatusValue): boolean {
  if (from === to) return false;
  return REFUND_STATUS_TRANSITIONS[from].includes(to);
}

export const updateRefundStatusSchema = z.object({
  id: z.string().min(1),
  status: refundStatusSchema,
});

// The input (pre-parse) type, not z.infer's output type — `channel` (like
// shippingCost/discountTotal/currency) has a `.default()`, so it's
// optional for a caller to supply even though createOrderAction's parsed
// result always has it set. Using the output type here would force every
// caller (the order form, every test that builds a minimal valid order)
// to pass it explicitly just to satisfy the type, for no behavioral gain.
export type CreateOrderInput = z.input<typeof createOrderSchema>;
