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

/** Stock transfer reference, e.g. "TR-000123" (Phase 32b). */
export function formatTransferNumber(transferNumber: number): string {
  return `TR-${transferNumber.toString().padStart(6, "0")}`;
}
