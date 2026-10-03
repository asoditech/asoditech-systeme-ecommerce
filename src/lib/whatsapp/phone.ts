import { toMoroccanWhatsAppDigits } from "@/lib/whatsapp";

/**
 * A staff member's own WhatsApp number → the Cloud API `to` format (E.164
 * digits, no "+"), or `null` when it is obviously invalid. Reuses the
 * project's Moroccan normalization (`toMoroccanWhatsAppDigits`: "06…",
 * "+212 6…", "212…", bare "6…" all → "2126…"); an explicit international
 * number ("+33…", "0033…") is kept as is. docs/adr/0058.
 */
export function normalizeStaffWhatsAppPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[+\d\s().-]+$/.test(trimmed)) return null; // letters, etc.
  const international = trimmed.startsWith("+") || trimmed.replace(/\D+/g, "").startsWith("00");
  let digits = trimmed.replace(/\D+/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!international || digits.startsWith("212")) digits = toMoroccanWhatsAppDigits(digits);
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null; // E.164: 8–15 digits, no leading 0
  // Moroccan numbers are exactly 212 + 9 digits, mobile ranges 6/7.
  if (digits.startsWith("212") && !/^212[67]\d{8}$/.test(digits)) return null;
  return digits;
}

/** "+212 6•• •• •• 78" — enough for the user to recognise their number. */
export function maskWhatsAppPhone(digits: string): string {
  return `+${digits.slice(0, 4)}${"•".repeat(Math.max(0, digits.length - 6))}${digits.slice(-2)}`;
}
