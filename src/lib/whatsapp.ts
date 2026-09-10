/**
 * Building a wa.me link to message a customer (distinct from
 * src/lib/support/contact.ts, which builds links to ASODITECH's own
 * support number). Moroccan numbers arrive in mixed shapes — local
 * "0612345678", international "+212612345678"/"212612345678", or bare
 * "612345678" (mirrors the reverse conversion in
 * src/lib/integrations/delivery/providers/ozonexpress/mapper.ts, which
 * normalizes the other way for the carrier's API) — wa.me needs the
 * international shape with no leading 0 and no "+".
 */
export function toMoroccanWhatsAppDigits(raw: string): string {
  const digits = raw.replace(/\D+/g, "");
  if (digits.startsWith("212")) return digits;
  if (digits.startsWith("0") && digits.length === 10) return "212" + digits.slice(1);
  if (digits.length === 9) return "212" + digits;
  return digits;
}

/**
 * `https://wa.me/<number>?text=<message>` for a customer's phone/WhatsApp
 * number, or `null` when the number doesn't look usable — better to hide
 * the action than build a dead link.
 */
export function buildCustomerWhatsAppUrl(raw: string | null | undefined, message?: string): string | null {
  if (!raw) return null;
  const digits = toMoroccanWhatsAppDigits(raw);
  if (digits.length < 10 || digits.length > 14) return null;
  const base = `https://wa.me/${digits}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}
