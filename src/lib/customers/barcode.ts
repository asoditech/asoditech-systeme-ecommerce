/**
 * Automatic customer codes « CL-000001 » (docs/adr/0060) — the pure, shared
 * part (server + client): format, the reserved pattern, scan normalisation.
 * Allocation (counter + collision checks) lives in ./barcode-allocation.ts.
 *
 * Codes are uppercase « CL- » + the tenant counter padded to 6 digits, growing
 * naturally past 999 999 (« CL-1000000 »). Rendered as Code 128.
 */

export const CUSTOMER_BARCODE_PREFIX = "CL-";

export function formatCustomerBarcode(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError("Numéro de code client invalide.");
  return `${CUSTOMER_BARCODE_PREFIX}${String(sequence).padStart(6, "0")}`;
}

/** The numeric part of a well-formed customer code, else null. */
export function parseCustomerBarcodeSequence(code: string | null | undefined): number | null {
  const match = /^CL-(\d+)$/.exec((code ?? "").trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * Keyboard-layout mismatch (same cause as src/lib/catalog/scan-input.ts): a
 * scanner sends KEY POSITIONS, the computer maps them with ITS layout. « C »
 * and « L » sit on the same keys in QWERTY and AZERTY, the digits and « - »
 * do not:
 *  - QWERTY scanner → AZERTY computer: « CL-000001 » arrives « CL)ààààà& »;
 *  - AZERTY scanner → QWERTY computer: it arrives « CL6))))))! ».
 */
const AZERTY_DIGITS: Record<string, string> = { "&": "1", "é": "2", '"': "3", "'": "4", "(": "5", "-": "6", "§": "6", "è": "7", "_": "8", "!": "8", "ç": "9", "à": "0" };
const QWERTY_SHIFTED_DIGITS: Record<string, string> = { "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0" };

function mapDigits(chars: string, map: Record<string, string>): string | null {
  if (chars.length === 0) return null;
  let out = "";
  for (const ch of chars) {
    const d = map[ch];
    if (d === undefined) return null;
    out += d;
  }
  return out;
}

export interface ScannedCustomerCode {
  /** The code to look up (uppercased; layout-corrected when detected). */
  code: string;
  /** True when the scan came through a mismatched keyboard layout. */
  layoutMismatch: boolean;
}

/**
 * What a customer-code field received → the code to look up. Never guesses
 * beyond the two layout swaps above; anything else is returned trimmed and
 * uppercased, unchanged.
 */
export function normalizeScannedCustomerCode(raw: string | null | undefined): ScannedCustomerCode {
  const trimmed = (raw ?? "").trim();
  const upper = trimmed.toUpperCase();
  if (/^CL-\d+$/.test(upper)) return { code: upper, layoutMismatch: false };
  if (upper.startsWith("CL") && upper.length > 3) {
    const rest = trimmed.slice(2);
    if (rest[0] === ")") {
      const digits = mapDigits(rest.slice(1), AZERTY_DIGITS);
      if (digits) return { code: `CL-${digits}`, layoutMismatch: true };
    }
    if (rest[0] === "6") {
      const digits = mapDigits(rest.slice(1), QWERTY_SHIFTED_DIGITS);
      if (digits) return { code: `CL-${digits}`, layoutMismatch: true };
    }
  }
  return { code: upper, layoutMismatch: false };
}

/** A customer-code-looking input (« CL… », any case, incl. a layout-swapped
 * scan) — used by customer pickers to route the lookup; never a product. */
export function looksLikeCustomerCode(raw: string | null | undefined): boolean {
  return /^cl/i.test((raw ?? "").trim());
}

export const SCANNER_LAYOUT_HINT =
  "Le lecteur semble configuré avec une autre disposition de clavier que cet ordinateur (AZERTY / QWERTY) : le code a été corrigé automatiquement. Réglez le lecteur sur la disposition de l'ordinateur.";
