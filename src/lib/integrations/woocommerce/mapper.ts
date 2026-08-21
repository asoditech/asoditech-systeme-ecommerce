import type { OrderStatus, PaymentMethod, ProductStatus } from "@prisma/client";
import type { WcOrder, WcProduct } from "./types";

/**
 * Pure mapping functions — no Prisma, no network calls, no side effects.
 * Field ownership: everything mapped here is WooCommerce-owned for a
 * synced record and is overwritten on every sync run. `cost` (products),
 * `lowStockThreshold` (products), `segment`/`tags`/`notes` (customers) are
 * deliberately never touched here — those stay internal-only, even for a
 * WooCommerce-sourced record. See docs/adr/0010-woocommerce-integration.md.
 */

/** WooCommerce's small closed set of product statuses maps to a safe default when unrecognized. */
export function mapProductStatus(wcStatus: string): ProductStatus {
  if (wcStatus === "publish") return "ACTIF";
  // draft | pending | private | anything unrecognized: never auto-publish a
  // product we're not sure is meant to be sellable.
  return "BROUILLON";
}

export interface MappedProductFields {
  name: string;
  sku: string;
  description: string | null;
  price: number;
  salePrice: number | null;
  status: ProductStatus;
  trackInventory: boolean;
}

export function mapProductFields(wc: WcProduct): MappedProductFields {
  return {
    name: wc.name,
    // A WooCommerce product with no SKU set is real and common — fall back
    // to a deterministic, traceable placeholder rather than an empty
    // string, which would collide with every other SKU-less product against
    // the internal SKU unique constraint.
    sku: wc.sku.trim() || `WC-${wc.id}`,
    description: wc.description?.trim() || null,
    price: wc.regular_price,
    salePrice: wc.sale_price && wc.sale_price > 0 && wc.sale_price < wc.regular_price ? wc.sale_price : null,
    status: mapProductStatus(wc.status),
    trackInventory: wc.manage_stock,
  };
}

/**
 * Order status mapping. WooCommerce's built-in statuses (pending,
 * processing, on-hold, completed, cancelled, refunded, failed) map
 * explicitly below. `checkout-draft`/`auto-draft`/`trash` are not real
 * orders and are never imported. Anything else (a custom status from a
 * third-party plugin) is deliberately left unmapped rather than guessed —
 * the caller must skip the order and report why, per the "never silently
 * invent a mapping" rule.
 */
const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  pending: "NOUVELLE",
  "on-hold": "NOUVELLE",
  processing: "CONFIRMEE",
  completed: "LIVREE",
  cancelled: "ANNULEE",
  refunded: "REMBOURSEE",
  failed: "ECHEC",
};

const UNSUPPORTED_ORDER_STATUSES = new Set(["checkout-draft", "auto-draft", "trash"]);

export type OrderStatusMapping =
  | { ok: true; status: OrderStatus }
  | { ok: false; reason: string };

export function mapOrderStatus(wcStatus: string): OrderStatusMapping {
  if (UNSUPPORTED_ORDER_STATUSES.has(wcStatus)) {
    return { ok: false, reason: `Statut WooCommerce non importable : ${wcStatus}.` };
  }
  const mapped = ORDER_STATUS_MAP[wcStatus];
  if (!mapped) {
    return { ok: false, reason: `Statut de commande WooCommerce non pris en charge : ${wcStatus}.` };
  }
  return { ok: true, status: mapped };
}

export interface MappedCustomerFields {
  fullName: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  country: string;
}

/** Prefers shipping name/address, falls back to billing — same convention as the order's own shipping snapshot. */
export function mapCustomerFieldsFromOrder(wc: WcOrder): MappedCustomerFields {
  const source = wc.shipping.address_1 ? wc.shipping : wc.billing;
  const fullName = [source.first_name, source.last_name].filter(Boolean).join(" ").trim();
  return {
    fullName: fullName || wc.billing.email || `Client WooCommerce #${wc.customer_id || wc.id}`,
    email: wc.billing.email?.trim() || null,
    phone: wc.billing.phone?.trim() || null,
    city: source.city?.trim() || null,
    region: source.state?.trim() || null,
    country: source.country?.trim() || "Maroc",
  };
}

export interface MappedOrderFields {
  status: OrderStatus;
  subtotal: number;
  discountTotal: number;
  shippingCost: number;
  total: number;
  currency: string;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
  notes: string | null;
}

export function mapOrderFields(wc: WcOrder, status: OrderStatus): MappedOrderFields {
  const shipping = wc.shipping.address_1 ? wc.shipping : wc.billing;
  const subtotal = wc.line_items.reduce((sum, li) => sum + li.subtotal, 0);
  return {
    status,
    subtotal,
    discountTotal: wc.discount_total,
    shippingCost: wc.shipping_total,
    total: wc.total,
    currency: wc.currency,
    shippingAddressLine1: shipping.address_1?.trim() || null,
    shippingAddressLine2: shipping.address_2?.trim() || null,
    shippingCity: shipping.city?.trim() || null,
    shippingRegion: shipping.state?.trim() || null,
    shippingCountry: shipping.country?.trim() || null,
    shippingPhone: wc.billing.phone?.trim() || null,
    notes: wc.customer_note?.trim() || null,
  };
}

/**
 * Only WooCommerce's four built-in core payment gateways (bacs, cheque,
 * cod, paypal) are mapped explicitly — everything else is a third-party
 * plugin gateway (Stripe, a local payment processor, etc.) whose id isn't
 * standardized enough to safely categorize, so it maps to AUTRE rather
 * than guessed.
 */
const PAYMENT_METHOD_MAP: Record<string, PaymentMethod> = {
  cod: "PAIEMENT_LIVRAISON",
  bacs: "VIREMENT_BANCAIRE",
  cheque: "AUTRE",
  paypal: "CARTE_BANCAIRE",
};

export function mapPaymentMethod(wcPaymentMethod: string | null | undefined): PaymentMethod {
  if (!wcPaymentMethod) return "AUTRE";
  return PAYMENT_METHOD_MAP[wcPaymentMethod] ?? "AUTRE";
}

/** WC refund `total` values are negative strings (e.g. "-10.00") — the absolute amount actually refunded. */
export function totalRefundedAmount(wc: WcOrder): number {
  return wc.refunds.reduce((sum, r) => sum + Math.abs(Number(r.total) || 0), 0);
}
