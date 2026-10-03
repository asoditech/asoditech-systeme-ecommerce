import { buildTelHref, buildWhatsAppUrl } from "@/lib/support/contact";

/**
 * Click-to-call and click-to-WhatsApp hrefs for a stored contact number
 * (customer, supplier, delivery). Pure — the stored value is never changed,
 * and the UI keeps displaying it exactly as entered.
 *
 * - `tel:` keeps the number as stored (digits and a leading "+"): a local
 *   number dials correctly from a phone in the same country, so no country
 *   code is ever added — src/lib/support/contact.ts#buildTelHref.
 * - WhatsApp (wa.me) needs the full international number. It is built ONLY
 *   when that number is unambiguous:
 *     · already international: "+…", "00…", or "212…" (12 digits);
 *     · Moroccan national format "0[5-7]" + 8 digits (10 digits): the
 *       trunk "0" is replaced by 212 — the fixed national dialling rule,
 *       not a guess.
 *   Anything else (a bare 9-digit number, a short or foreign local number)
 *   gets no WhatsApp link rather than a link built on an invented country
 *   code. Stricter on purpose than src/lib/whatsapp.ts (kept unchanged for
 *   the confirmation queue), which also prefixes bare 9-digit numbers.
 */

export function phoneTelHref(raw: string | null | undefined): string | null {
  return buildTelHref(raw);
}

export function phoneWhatsAppHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D+/g, "");
  let international: string | null = null;
  if (trimmed.startsWith("+")) international = digits;
  else if (digits.startsWith("00")) international = digits.slice(2);
  else if (digits.startsWith("212") && digits.length === 12) international = digits;
  else if (/^0[5-7]\d{8}$/.test(digits)) international = "212" + digits.slice(1);
  if (!international) return null;
  // buildWhatsAppUrl re-validates the E.164 length (8–15 digits).
  return buildWhatsAppUrl(international);
}
