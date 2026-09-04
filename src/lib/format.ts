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

export function formatOrderNumber(orderNumber: number, prefix = "CMD"): string {
  return `${prefix}-${orderNumber.toString().padStart(6, "0")}`;
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
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  externalNumber?: string | null;
}): string {
  if (order.source !== "INTERNE" && order.externalNumber) {
    return `#${order.externalNumber}`;
  }
  return formatOrderNumber(order.orderNumber);
}

/** Stock transfer reference, e.g. "TR-000123" (Phase 32b). */
export function formatTransferNumber(transferNumber: number): string {
  return `TR-${transferNumber.toString().padStart(6, "0")}`;
}

/** Stocktake session reference, e.g. "INV-000123" (Phase 32c). */
export function formatStocktakeNumber(sessionNumber: number): string {
  return `INV-${sessionNumber.toString().padStart(6, "0")}`;
}
