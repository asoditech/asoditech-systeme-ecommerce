import { gs1CheckDigit } from "@/lib/catalog/gs1";

/**
 * What a scanned / typed code IS, before (and independently of) the product
 * lookup. Pure, client-safe — used by the server lookup (label QR) and by
 * the scan screens' « not found » messages (diagnostic hints).
 *
 * Nothing here rewrites a code into another one: the only code that is
 * resolved differently is ASODITECH's OWN label QR (`/scan/<token>`, see
 * src/lib/catalog/labels.ts#scanUrl), which the lookup resolves by its
 * token inside the caller's tenant. Every other observation is only a HINT
 * shown with « code inconnu » — e.g. digits that a QWERTY-configured
 * scanner typed on an AZERTY computer are explained, never converted.
 */

/** Same alphabet/length as `generateRawToken` (32 bytes, base64url → 43 chars); ≥ 16 as `resolveScanToken`. */
const LABEL_URL = /^https?:\/\/[^/\s]+\/scan\/([A-Za-z0-9_-]{16,128})\/?$/i;

/** The token of an ASODITECH label QR (`https://<host>/scan/<token>`), or null. The host is not trusted for anything: the token only resolves inside the caller's own tenant. */
export function labelQrToken(code: string | null | undefined): string | null {
  const m = LABEL_URL.exec((code ?? "").trim());
  return m ? m[1] : null;
}

/**
 * Keyboard-layout mismatch: a scanner sends KEY POSITIONS, the computer turns
 * them into characters with ITS layout. A scanner set to US (QWERTY) on a
 * French AZERTY computer types the digit keys unshifted → « &é"'(-è_çà »
 * (Belgian AZERTY: « § » for 6, « ! » for 8). The reverse (AZERTY scanner,
 * QWERTY computer) gives the shifted symbols « !@#$%^&*() ».
 */
const AZERTY_DIGIT_ROW: Record<string, string> = { "&": "1", "é": "2", '"': "3", "'": "4", "(": "5", "-": "6", "§": "6", "è": "7", "_": "8", "!": "8", "ç": "9", "à": "0" };
const QWERTY_SHIFTED_ROW: Record<string, string> = { "!": "1", "@": "2", "#": "3", $: "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0" };

function asDigitRow(code: string, map: Record<string, string>): string | null {
  if (code.length < 4) return null;
  let out = "";
  for (const ch of code) {
    const d = map[ch];
    if (d === undefined) return null;
    out += d;
  }
  return out;
}

export type ScanHintKind =
  | "label-qr"
  | "web-url"
  | "layout-azerty"
  | "layout-qwerty"
  | "layout-url"
  | "aim-prefix"
  | "gtin-check-digit"
  | "whitespace";

export interface ScanHint {
  kind: ScanHintKind;
  message: string;
}

/**
 * Why a code that matched nothing may not be the code the operator meant.
 * null = nothing suspicious (then it simply isn't in the catalogue). Only
 * ever shown next to « code inconnu » — never used to change the lookup.
 */
export function scanMissHint(raw: string | null | undefined): ScanHint | null {
  const code = (raw ?? "").trim();
  if (!code) return null;

  if (labelQrToken(code)) {
    return {
      kind: "label-qr",
      message: "C'est le QR code d'une étiquette ASODITECH, mais il ne correspond à aucun article actif de ce compte (étiquette d'un autre compte, ou article supprimé).",
    };
  }
  // A US-layout scanner on an AZERTY computer: « https:// » arrives as « httpsM!! ».
  if (/^https?M!!/i.test(code)) {
    return {
      kind: "layout-url",
      message: "Le scanner a lu un QR code (lien web), et sa langue de clavier ne correspond pas à celle de l'ordinateur. Configurez le scanner en clavier « Français (AZERTY) », et scannez le code-barres linéaire (les barres) plutôt que le QR.",
    };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(code) || /^www\./i.test(code)) {
    return { kind: "web-url", message: "Le code lu est un lien web (QR code), pas un code-barres ou un SKU d'article." };
  }
  const azerty = asDigitRow(code, AZERTY_DIGIT_ROW);
  if (azerty) {
    return {
      kind: "layout-azerty",
      message: `Ces caractères correspondent aux chiffres « ${azerty} » tapés par un scanner réglé en clavier QWERTY sur un ordinateur AZERTY. Configurez le scanner en clavier « Français (AZERTY) » (code de configuration du manuel du scanner), puis scannez à nouveau.`,
    };
  }
  const qwerty = asDigitRow(code, QWERTY_SHIFTED_ROW);
  if (qwerty) {
    return {
      kind: "layout-qwerty",
      message: `Ces caractères correspondent aux chiffres « ${qwerty} » tapés par un scanner réglé en clavier AZERTY sur un ordinateur QWERTY. Réglez la langue de clavier du scanner comme celle de l'ordinateur, puis scannez à nouveau.`,
    };
  }
  // AIM symbology identifier (« ]E0 », « ]C1 », « ]Q1 »…) sent before the data.
  if (/^\][A-Za-z][0-9A-Za-z]/.test(code)) {
    return {
      kind: "aim-prefix",
      message: `Le scanner ajoute un préfixe d'identification (« ${code.slice(0, 3)} ») devant le code. Désactivez l'option « AIM ID / Code ID / préfixe » du scanner.`,
    };
  }
  if (/^\d+$/.test(code) && [8, 12, 13, 14].includes(code.length) && gs1CheckDigit(code.slice(0, -1)) !== Number(code.at(-1))) {
    return {
      kind: "gtin-check-digit",
      message: "Si c'est un code EAN/UPC, ses chiffres sont incomplets ou erronés (chiffre de contrôle invalide) : rescannez-le ou vérifiez la saisie.",
    };
  }
  if (/\s/.test(code)) {
    return { kind: "whitespace", message: "Le code contient des espaces : vérifiez les réglages de préfixe/suffixe du scanner." };
  }
  return null;
}

/** Shortens a code for a message (a garbled scan can be long). */
export function scanCodeForMessage(code: string, max = 60): string {
  const c = code.trim();
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

/** « code inconnu » message + the hint, when there is one. */
export function withScanHint(message: string, code: string): string {
  const hint = scanMissHint(code);
  return hint ? `${message} ${hint.message}` : message;
}
