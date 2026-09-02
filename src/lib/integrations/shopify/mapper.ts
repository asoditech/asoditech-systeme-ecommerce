import type { OrderStatus, PaymentMethod, ProductStatus } from "@prisma/client";
import { stripHtml } from "@/lib/integrations/shared";
import type { ShopifyOrder, ShopifyProduct, ShopifyVariant } from "./types";

/**
 * Pure mapping functions — no Prisma, no network calls, no side effects.
 * Field ownership: everything mapped here is Shopify-owned for a synced
 * record and is overwritten on every sync run. `cost` (products),
 * `lowStockThreshold` (products), `segment`/`tags`/`notes` (customers) are
 * deliberately never touched here — internal-only, exactly like the
 * WooCommerce integration. See docs/adr/0011-shopify-integration.md.
 */

/** Shopify's ProductStatus (ACTIVE/ARCHIVED/DRAFT) maps to a safe default when unrecognized. */
export function mapProductStatus(shopifyStatus: string): ProductStatus {
  if (shopifyStatus === "ACTIVE") return "ACTIF";
  if (shopifyStatus === "ARCHIVED") return "ARCHIVE";
  // DRAFT | anything unrecognized: never auto-publish a product we're not
  // sure is meant to be sellable.
  return "BROUILLON";
}

/**
 * Every Shopify product has at least one variant — a hidden
 * "Default Title" variant for non-configurable products. Only when a
 * product has more than one variant, or its single variant carries a
 * real (non-"Default Title") name, is it treated as this system's
 * "variable" product model (a ProductVariation per Shopify variant).
 * Otherwise it's "simple": the single variant's sku/price map directly
 * onto the Product row and no ProductVariation is created — matching how
 * the WooCommerce integration (and this system's own manual product
 * creation) already distinguishes simple vs. variable products.
 */
export function isSimpleProduct(product: ShopifyProduct): boolean {
  return product.variants.nodes.length === 1 && product.variants.nodes[0].title === "Default Title";
}

export interface MappedProductFields {
  name: string;
  sku: string;
  description: string | null;
  price: number;
  status: ProductStatus;
  trackInventory: boolean;
}

function skuOrFallback(sku: string | null | undefined, fallbackId: string): string {
  const trimmed = sku?.trim();
  if (trimmed) return trimmed;
  // Shopify's opaque gid (e.g. "gid://shopify/ProductVariant/123") always
  // has a numeric-ish trailing segment — reuse it for a short, readable,
  // deterministic fallback rather than an empty string, which would
  // collide with every other SKU-less product against the internal SKU
  // unique constraint.
  const shortId = fallbackId.split("/").pop() ?? fallbackId;
  return `SHOPIFY-${shortId}`;
}

export function mapSimpleProductFields(product: ShopifyProduct): MappedProductFields {
  const variant = product.variants.nodes[0];
  return {
    name: product.title,
    sku: skuOrFallback(variant?.sku, variant?.id ?? product.id),
    description: stripHtml(product.descriptionHtml),
    price: variant ? Number(variant.price) : 0,
    status: mapProductStatus(product.status),
    trackInventory: variant?.inventoryItem.tracked ?? false,
  };
}

export function mapVariantFields(variant: ShopifyVariant): { sku: string; price: number; trackInventory: boolean } {
  return {
    sku: skuOrFallback(variant.sku, variant.id),
    price: Number(variant.price),
    trackInventory: variant.inventoryItem.tracked,
  };
}

/**
 * Order status mapping. Shopify reports order state along TWO independent
 * dimensions (OrderDisplayFinancialStatus, OrderDisplayFulfillmentStatus)
 * plus a separate cancellation signal — there is no single "order status"
 * field like WooCommerce's. Every branch below matches an explicit,
 * verified enum value (see docs/adr/0011-shopify-integration.md for the
 * full verified enum lists); an unrecognized or unhandled combination is
 * reported and skipped, never guessed.
 *
 * Priority (checked in order, first match wins):
 * 1. cancelledAt set, or financial VOIDED → ANNULEE
 * 2. financial REFUNDED → REMBOURSEE
 * 3. fulfillment RESTOCKED → RETOUR
 * 4. fulfillment FULFILLED → LIVREE
 * 5. fulfillment PARTIALLY_FULFILLED / IN_PROGRESS → EXPEDIEE
 * 6. financial EXPIRED → ECHEC
 * 7. financial PAID or PARTIALLY_PAID, fulfillment not yet shipped → CONFIRMEE
 * 8. financial PENDING or AUTHORIZED, fulfillment not yet shipped → NOUVELLE
 */
export type OrderStatusMapping = { ok: true; status: OrderStatus } | { ok: false; reason: string };

const UNSHIPPED_FULFILLMENT = new Set(["UNFULFILLED", "OPEN", "PENDING_FULFILLMENT", "SCHEDULED", "ON_HOLD", "REQUEST_DECLINED"]);

export function mapOrderStatus(
  financial: string | null | undefined,
  fulfillment: string | null | undefined,
  cancelledAt: string | null | undefined
): OrderStatusMapping {
  if (cancelledAt) return { ok: true, status: "ANNULEE" };
  if (financial === "VOIDED") return { ok: true, status: "ANNULEE" };
  if (financial === "REFUNDED") return { ok: true, status: "REMBOURSEE" };
  if (fulfillment === "RESTOCKED") return { ok: true, status: "RETOUR" };
  if (fulfillment === "FULFILLED") return { ok: true, status: "LIVREE" };
  if (fulfillment === "PARTIALLY_FULFILLED" || fulfillment === "IN_PROGRESS") return { ok: true, status: "EXPEDIEE" };
  if (financial === "EXPIRED") return { ok: true, status: "ECHEC" };
  if ((financial === "PAID" || financial === "PARTIALLY_PAID") && fulfillment && UNSHIPPED_FULFILLMENT.has(fulfillment)) {
    return { ok: true, status: "CONFIRMEE" };
  }
  if ((financial === "PENDING" || financial === "AUTHORIZED") && fulfillment && UNSHIPPED_FULFILLMENT.has(fulfillment)) {
    return { ok: true, status: "NOUVELLE" };
  }
  return {
    ok: false,
    reason: `Combinaison de statuts Shopify non prise en charge : financier=${financial ?? "?"}, exécution=${fulfillment ?? "?"}.`,
  };
}

/**
 * Only a couple of Shopify's own well-known gateway ids are mapped
 * explicitly — merchant-configured gateway names vary too much to
 * categorize reliably (unlike WooCommerce's four fixed core gateways).
 */
const PAYMENT_GATEWAY_MAP: Record<string, PaymentMethod> = {
  cash_on_delivery: "PAIEMENT_LIVRAISON",
  bank_deposit: "VIREMENT_BANCAIRE",
  shopify_payments: "CARTE_BANCAIRE",
};

export function mapPaymentMethod(gatewayNames: string[]): PaymentMethod {
  for (const name of gatewayNames) {
    const mapped = PAYMENT_GATEWAY_MAP[name];
    if (mapped) return mapped;
  }
  return "AUTRE";
}

export function totalRefundedAmount(order: ShopifyOrder): number {
  return order.totalRefundedSet.amount;
}
