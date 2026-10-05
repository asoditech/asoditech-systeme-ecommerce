/**
 * Customer identity — pure, client-safe helpers.
 *
 * Business rule: a customer IS « normalized name + normalized phone ».
 *   same name + same phone  → the same customer (reused, never re-created)
 *   same phone, other name  → a different customer
 *   same name, other phone  → a different customer
 *   missing/invalid phone   → no matching at all
 * No fuzzy matching: spelling / transliteration variants are different names.
 */

/**
 * Phone in one canonical form — international digits without "+", e.g.
 * "212612345678". "+"/"00" numbers are kept as international; Moroccan
 * local numbers ("06…", "05…", "07…", or 9 digits "6…") become "212…".
 * Returns null when missing or not a plausible number (then: no matching).
 */
export function customerPhoneKey(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (!/^[+\d\s().\-/]+$/.test(value)) return null; // letters etc.
  let digits = value.replace(/\D+/g, "");
  if (!digits) return null;
  let international = value.startsWith("+");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
    international = true;
  }
  if (!international) {
    if (/^0[5-7]\d{8}$/.test(digits)) digits = "212" + digits.slice(1);
    else if (/^[5-7]\d{8}$/.test(digits)) digits = "212" + digits;
  }
  if (digits.startsWith("212")) return /^212[5-7]\d{8}$/.test(digits) ? digits : null;
  return international && /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/**
 * Name as compared for identity: trimmed, inner spaces collapsed, case and
 * accents ignored, invisible characters removed. Returns null for an empty
 * name or a placeholder that sync jobs invent when a name is missing (an
 * e-mail address, « Client WooCommerce #… », « Client Shopify … ») — those
 * never match anyone automatically.
 */
export function customerNameKey(raw: string | null | undefined): string | null {
  const value = (raw ?? "").normalize("NFKC").replace(/[​-‍﻿­]/g, "");
  if (isPlaceholderCustomerName(value)) return null;
  const key = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return key || null;
}

export function isPlaceholderCustomerName(raw: string | null | undefined): boolean {
  const value = (raw ?? "").trim();
  return value.includes("@") || /^client (woocommerce|shopify)\b/i.test(value);
}

/** Same person? Only when BOTH normalized name and normalized phone are present and equal. */
export function isSameCustomerIdentity(
  a: { fullName: string | null | undefined; phone: string | null | undefined },
  b: { fullName: string | null | undefined; phone: string | null | undefined }
): boolean {
  const pa = customerPhoneKey(a.phone);
  const na = customerNameKey(a.fullName);
  return pa !== null && na !== null && pa === customerPhoneKey(b.phone) && na === customerNameKey(b.fullName);
}

/** "••••••78" — enough for a seller to recognise a number without exposing it. */
export function maskCustomerPhone(phoneKeyOrRaw: string | null | undefined): string {
  const digits = (phoneKeyOrRaw ?? "").replace(/\D+/g, "");
  return digits.length >= 2 ? `••••••${digits.slice(-2)}` : "—";
}
