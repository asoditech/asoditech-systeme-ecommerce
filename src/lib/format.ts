import { RECORD_SOURCE_LABELS, ORDER_CHANNEL_LABELS } from "@/lib/status-labels";

export function formatCurrency(amount: number | string, currency: string = "MAD"): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  try {
    return new Intl.NumberFormat("fr-MA", { style: "currency", currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("fr-FR").format(value);
}

export function formatPercent(value: number, digits = 1): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(d);
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** "YYYY-MM" -> "septembre 2026" — the usage/billing period label
 * (docs/adr/0035). Parsed as UTC noon to avoid a local-timezone rollover
 * shifting the displayed month near midnight. */
export function formatPeriodLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, 15, 12));
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);
}

export function formatOrderNumber(orderNumber: number, prefix = "CMD"): string {
  return `${prefix}-${orderNumber.toString().padStart(6, "0")}`;
}

/**
 * The number to actually display for an order/transfer/stocktake row
 * (Phase 3 — docs/adr/0025-multi-tenant-isolation.md): the per-tenant
 * `displayNumber` when one was assigned, else the legacy GLOBAL number
 * every pre-Phase-3 row still has. Never renumbers history — a row's
 * `displayNumber` is null forever if it predates Phase 3.
 */
export function resolvedDisplayNumber(row: { displayNumber?: number | null }, legacyNumber: number): number {
  return row.displayNumber ?? legacyNumber;
}

/**
 * The order reference to actually show someone. A manually-created order
 * has no external reference — the internal `CMD-000039` sequence is its
 * only identity. An order imported from WooCommerce/Shopify already has a
 * real, human-recognizable number from that store (`externalNumber` —
 * WooCommerce's own "988467" or Shopify's "1042"); showing the *internal*
 * sequence for those instead matches nothing the store admin or the
 * customer ever sees. Falls back to the internal number if an imported
 * order somehow lacks one.
 */
export function displayOrderNumber(order: {
  orderNumber: number;
  displayNumber?: number | null;
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  externalNumber?: string | null;
}): string {
  if (order.source !== "INTERNE" && order.externalNumber) {
    return `#${order.externalNumber}`;
  }
  return formatOrderNumber(resolvedDisplayNumber(order, order.orderNumber));
}

/**
 * This deployment ships from and to Morocco. An order whose country was
 * never captured (a WooCommerce checkout with no country field, an older
 * manual order) is treated as Maroc rather than shown as "manquant" or
 * blocking shipment creation.
 */
export const DEFAULT_SHIPPING_COUNTRY = "Maroc";

export function orderShippingCountry(order: { shippingCountry?: string | null }): string {
  return order.shippingCountry?.trim() || DEFAULT_SHIPPING_COUNTRY;
}

/**
 * The name to show for an order — its own recipient snapshot
 * (`shippingName`), taken at import/creation time, NOT the linked
 * customer's canonical name: two orders under one WooCommerce account can
 * carry different billing names. Falls back to the customer for
 * pre-snapshot rows. See docs/adr/0030.
 */
export function displayOrderRecipient(order: {
  shippingName?: string | null;
  customer?: { fullName: string } | null;
}): string {
  return order.shippingName?.trim() || order.customer?.fullName || "Client";
}

/**
 * Where an order came from, for display — a WooCommerce/Shopify-imported
 * order derives it from `source` itself (the store IS the channel); a
 * manually-created order shows its own `channel` (Téléphone, WhatsApp,
 * …), or "Autre" for one entered before this field existed.
 */
export function displayOrderChannel(order: {
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  channel?: string | null;
}): string {
  if (order.source !== "INTERNE") return RECORD_SOURCE_LABELS[order.source];
  return (order.channel && ORDER_CHANNEL_LABELS[order.channel]) || ORDER_CHANNEL_LABELS.AUTRE;
}

/** Stock transfer reference, e.g. "TR-000123" (Phase 32b). */
export function formatTransferNumber(transferNumber: number): string {
  return `TR-${transferNumber.toString().padStart(6, "0")}`;
}

/** Stocktake session reference, e.g. "INV-000123" (Phase 32c). */
export function formatStocktakeNumber(sessionNumber: number): string {
  return `INV-${sessionNumber.toString().padStart(6, "0")}`;
}

/** Stock transfer reference from the row itself — prefers the per-tenant
 * `displayNumber` (Phase 3) over the legacy global `transferNumber`. */
export function displayTransferNumber(transfer: { transferNumber: number; displayNumber?: number | null }): string {
  return formatTransferNumber(resolvedDisplayNumber(transfer, transfer.transferNumber));
}

/** Stocktake session reference from the row itself — prefers the
 * per-tenant `displayNumber` (Phase 3) over the legacy global `sessionNumber`. */
export function displayStocktakeNumber(session: { sessionNumber: number; displayNumber?: number | null }): string {
  return formatStocktakeNumber(resolvedDisplayNumber(session, session.sessionNumber));
}
