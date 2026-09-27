/**
 * Reception document reference — smart initial suggestion (Batch 9, Group
 * 9). Pure, DB-free, client-safe: the reception form calls this to pre-fill
 * its "BL / N° livraison ou facture" field, never to validate or enforce
 * anything — the field stays a free-text, always-editable, internal
 * reference. It never pretends to be the supplier's own official BL/invoice
 * number, and it is never re-checked for uniqueness against anything: the
 * existing field's own validation/uniqueness rules (if any) are untouched.
 *
 * Format: `YYMMDD-XXX-001` (today's local date, the first 3 letters of the
 * supplier's name uppercased, then a fixed "-001" placeholder sequence) —
 * or just `YYMMDD` before a supplier is chosen. The trailing sequence is
 * deliberately a static placeholder, not a real collision check against
 * prior receptions: this is only ever a suggested STARTING POINT the
 * operator can freely edit (including bumping the sequence by hand for a
 * second reception from the same supplier the same day), not a guarantee.
 */
export function suggestReceptionReference(date: Date, supplierName: string | null | undefined): string {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const datePart = `${yy}${mm}${dd}`;

  const initials = (supplierName ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 3);

  return initials ? `${datePart}-${initials}-001` : datePart;
}
