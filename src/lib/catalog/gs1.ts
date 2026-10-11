/**
 * Non-blocking GS1 check-digit hint for barcode entry. Pure, client-safe.
 *
 * Only a code made of EXACTLY 8, 12, 13 or 14 digits (the GTIN-8 / UPC-A /
 * EAN-13 / GTIN-14 lengths) is checked. A mismatch only produces a warning:
 * a numeric code of those lengths is not necessarily a GTIN (internal or
 * supplier codes can be numeric too), so the code is never rejected and
 * never modified — saving stays allowed. Barcodes remain opaque everywhere
 * else (src/lib/catalog/barcodes.ts).
 */

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** GS1 mod-10: weights 3,1,3,1… from the rightmost data digit (the check digit excluded). */
export function gs1CheckDigit(dataDigits: string): number {
  let sum = 0;
  for (let i = 0; i < dataDigits.length; i++) {
    const digit = dataDigits.charCodeAt(dataDigits.length - 1 - i) - 48;
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** A French warning when `code` looks like a GTIN but its check digit is wrong; null otherwise (including every non-applicable code). */
export function gs1CheckDigitWarning(code: string | null | undefined): string | null {
  const c = (code ?? "").trim();
  if (!/^\d+$/.test(c) || !GTIN_LENGTHS.has(c.length)) return null;
  const expected = gs1CheckDigit(c.slice(0, -1));
  if (expected === Number(c.at(-1))) return null;
  return `Ce code ressemble à un EAN/UPC/GTIN mais son chiffre de contrôle ne correspond pas (attendu : ${expected}). Vérifiez la saisie — vous pouvez quand même l'enregistrer.`;
}

/**
 * The other spellings of the SAME GTIN a scanner may send: a UPC-A
 * "012345678905" is the EAN-13 "0012345678905" and the GTIN-14
 * "00012345678905" — scanners (and the camera decoder) report 12 or 13
 * digits depending on their settings. Only for a 12/13/14-digit code with a
 * VALID check digit (an internal numeric code is never reinterpreted); the
 * code itself is not included. Used only as a lookup fallback after the
 * exact code found nothing — stored barcodes are never rewritten.
 */
export function gtinEquivalents(code: string | null | undefined): string[] {
  const c = (code ?? "").trim();
  if (!/^\d+$/.test(c) || ![12, 13, 14].includes(c.length)) return [];
  if (gs1CheckDigit(c.slice(0, -1)) !== Number(c.at(-1))) return [];
  const gtin14 = c.padStart(14, "0");
  const out: string[] = [];
  for (const len of [12, 13, 14]) {
    const zeros = 14 - len;
    if (gtin14.slice(0, zeros) !== "0".repeat(zeros)) continue;
    const variant = gtin14.slice(zeros);
    if (variant !== c) out.push(variant);
  }
  return out;
}
