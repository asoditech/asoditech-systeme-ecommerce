/**
 * Pure builders for the support widget's human-contact actions. No DB, no
 * React — safe to unit test in isolation. WhatsApp and phone are kept
 * strictly separate: a configured phone number is never assumed to also be
 * a WhatsApp number (client requirement).
 */

/** Digits only, with any leading `00` international prefix reduced to none
 * (wa.me wants a bare country-code-prefixed number, no `+`, no `00`). */
export function normalizeWhatsappNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D+/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  // A real MSISDN is 8–15 digits (ITU E.164). Anything shorter is a
  // misconfiguration — better to hide the action than build a dead link.
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/**
 * `https://wa.me/<number>?text=<message>` from a configured WhatsApp
 * number, or `null` when the number is missing/invalid so the caller can
 * hide the action. The message is optional pre-filled context.
 */
export function buildWhatsAppUrl(
  rawNumber: string | null | undefined,
  message?: string | null,
): string | null {
  const number = normalizeWhatsappNumber(rawNumber);
  if (!number) return null;
  const base = `https://wa.me/${number}`;
  const text = message?.trim();
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

/**
 * A `tel:` href from a configured support phone number, or `null` when it
 * is missing/unusable. Keeps a leading `+` and digits, drops spaces,
 * dashes, parentheses.
 */
export function buildTelHref(rawPhone: string | null | undefined): string | null {
  if (!rawPhone) return null;
  const trimmed = rawPhone.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length < 6 || digits.length > 15) return null;
  return `tel:${plus}${digits}`;
}
