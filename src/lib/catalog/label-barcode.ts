/**
 * What the printable label (src/components/products/printable-label.tsx)
 * encodes as its linear barcode. Pure, client-safe.
 *
 * - "official": the unit's primary Barcode — a supplier/customer-entered code
 *   (the app never generates one), encoded exactly as stored.
 * - "internal": no Barcode at all → the unit's EXISTING SKU, encoded as
 *   Code 128 and printed as an internal code, NOT an EAN/GTIN. Nothing is
 *   stored: the official Barcode field stays empty, so the value can never
 *   be exported as a GTIN (catalog CSV export reads only the Barcode table).
 *   Scanning it works through the existing exact-SKU match in
 *   src/lib/catalog/lookup.ts.
 * - "none": no barcode and a SKU that Code 128 cannot carry as printable text.
 */
export type LabelBarcode =
  | { kind: "official"; value: string }
  | { kind: "internal"; value: string }
  | { kind: "none" };

/** Printable ASCII (space to "~"): within Code 128's character set and readable under the bars. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
/** Beyond this a Code 128 symbol gets too wide for the label. */
export const INTERNAL_CODE_MAX_LENGTH = 40;

export const INTERNAL_CODE_CAPTION = "CODE INTERNE — PAS UN EAN/GTIN";

export function labelBarcode(input: { barcode: string | null | undefined; sku: string | null | undefined }): LabelBarcode {
  const official = input.barcode?.trim();
  if (official) return { kind: "official", value: official };
  const sku = input.sku?.trim();
  if (sku && sku.length <= INTERNAL_CODE_MAX_LENGTH && PRINTABLE_ASCII.test(sku)) return { kind: "internal", value: sku };
  return { kind: "none" };
}
