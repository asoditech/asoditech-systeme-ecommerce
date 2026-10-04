import { skuFold } from "@/lib/catalog/variations";

/**
 * « Générer » suggestions for a product's SKU and model reference (product
 * creation form). Pure and deterministic — a SUGGESTION only: the user can
 * edit it, and the server's existing SKU validation and uniqueness checks
 * (`skuSchema`, `assertSkuFreeOfBarcodeAndSiblings`) stay authoritative.
 *
 *   SKU        = SKU-NAMECODE-NNNN   e.g. SKU-HC-0001 (« Hoodie cachmir »)
 *   Reference  = REF-NAMECODE-NNNN   e.g. REF-HC-0001
 *
 * The prefixes make the two identifiers distinguishable at a glance; the
 * sequence starts at 4 digits (large catalogues) and simply grows past 9999
 * (10000, 10001, …) — never truncated or reset.
 *
 * NAMECODE = the initial of each word of the name (« T-shirt Basic Noir » →
 * TBN), or the first 3 characters for a one-word name (« Casquette » → CAS).
 * Normalization reuses `skuFold` (the variation SKU convention): accents
 * stripped, uppercase, anything but A–Z / 0–9 → "-".
 */

const MAX_INITIALS = 5;
/** skuSchema allows 64 characters; leave room for "-NNNN" (or a longer sequence). */
const MAX_BASE_LENGTH = 48;
const SEQUENCE_DIGITS = 4;

/** « T-shirt Basic Noir » → "TBN"; « Casquette » → "CAS"; "" → "". */
export function nameCode(name: string | null | undefined): string {
  const words = (name ?? "")
    .split(/\s+/)
    .map((w) => skuFold(w))
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].replace(/-/g, "").slice(0, 3);
  return words
    .map((w) => w[0])
    .join("")
    .slice(0, MAX_INITIALS);
}

function clampBase(base: string): string {
  return base.slice(0, MAX_BASE_LENGTH).replace(/-+$/g, "");
}

/** SKU base (without sequence): "SKU-HC". "" when the name gives no code. */
export function productSkuBase(name: string | null | undefined): string {
  const code = nameCode(name);
  return code ? clampBase(`SKU-${code}`) : "";
}

/** Reference base (without sequence): "REF-HC". "" when the name gives no code. */
export function productReferenceBase(name: string | null | undefined): string {
  const code = nameCode(name);
  return code ? clampBase(`REF-${code}`) : "";
}

/** "SKU-HC" + 1 → "SKU-HC-0001"; 10000 → "SKU-HC-10000" (grows, never truncated). */
export function withSequence(base: string, n: number): string {
  return `${base}-${String(n).padStart(SEQUENCE_DIGITS, "0")}`;
}

/**
 * The first `base-NNNN` (from 0001) not in `taken` — compared
 * case-insensitively, like a person reading the codes. No upper limit: among
 * `taken.size + 1` candidates at least one is free. null when the base is empty.
 */
export function nextSequencedCode(base: string, taken: Iterable<string>): string | null {
  if (!base) return null;
  const used = new Set([...taken].map((t) => t.toLowerCase()));
  for (let n = 1; n <= used.size + 1; n++) {
    const candidate = withSequence(base, n);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return null; // unreachable
}

/**
 * What « Générer » does with the field's current value: an empty field is
 * filled directly; a different non-empty value is NEVER replaced silently —
 * the form asks for confirmation first; the same value needs nothing.
 */
export function generatedValueAction(current: string, suggestion: string): "fill" | "confirm" | "none" {
  const value = current.trim();
  if (!value) return "fill";
  return value === suggestion.trim() ? "none" : "confirm";
}
