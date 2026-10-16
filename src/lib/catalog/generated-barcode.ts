import { gs1CheckDigit } from "@/lib/catalog/gs1";

const ONE = BigInt(1);

/**
 * Generated product / variation barcodes (docs/adr/0061) — pure, client-safe.
 *
 * Format: an EAN-13-shaped GS1 **Restricted Circulation Number**:
 *   "20" + 10-digit tenant sequence (zero-padded) + GS1 mod-10 check digit.
 * - GS1 reserves the 20–29 prefixes for numbers used INSIDE a company; they
 *   are not GTINs and never collide with a real retail GTIN.
 * - 13 digits with a valid check digit: the app's own GS1 check
 *   (gs1CheckDigitWarning) stays silent, the camera decoder reads it as
 *   ean_13 (RELEVANT_BARCODE_FORMATS), the printable label encodes it as Code
 *   128 like every stored code, and an all-digit code keeps the existing
 *   AZERTY/QWERTY scanner hint (src/lib/catalog/scan-input.ts).
 * - Starting with "2", it can never be a GTIN-equivalent spelling of a stored
 *   UPC/GTIN-14 (those equivalences need leading zeros — gtinEquivalents).
 * - It is a STRING: inner zeros are preserved exactly; nothing parses it to a
 *   number outside this module.
 */

export const GENERATED_BARCODE_PREFIX = "20";
/** 10 digits of sequence → 10 000 000 000 codes per tenant. */
export const GENERATED_BARCODE_SEQUENCE_DIGITS = 10;
export const GENERATED_BARCODE_MAX_SEQUENCE = BigInt("9999999999");

const GENERATED_PATTERN = /^20\d{11}$/;

export function formatGeneratedProductBarcode(sequence: bigint | number): string {
  const n = BigInt(sequence);
  if (n < ONE || n > GENERATED_BARCODE_MAX_SEQUENCE) throw new RangeError("Numéro de code-barres hors limites.");
  const data = `${GENERATED_BARCODE_PREFIX}${n.toString().padStart(GENERATED_BARCODE_SEQUENCE_DIGITS, "0")}`;
  return `${data}${gs1CheckDigit(data)}`;
}

/**
 * True for a code of THIS generator's shape (prefix 20, 13 digits, valid check
 * digit). Such a code is an internal number, not a GTIN: the catalog export
 * never writes it into a store's GTIN/barcode column and the label captions it
 * as internal. (A merchant who typed a genuine « 20… » code gets the same
 * treatment, which is also GS1-correct: 20–29 are not traded GTINs.)
 */
export function isGeneratedProductBarcode(code: string | null | undefined): boolean {
  const c = (code ?? "").trim();
  return GENERATED_PATTERN.test(c) && gs1CheckDigit(c.slice(0, -1)) === Number(c.at(-1));
}
