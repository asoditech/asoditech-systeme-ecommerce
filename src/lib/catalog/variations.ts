/**
 * Variant combination generation + SKU suggestion (Batch 4 — Variant System
 * Rebuild). Pure, DB-free functions — kept separate from the server actions
 * that call them so they're trivially unit-testable, mirroring the
 * pure/impure split already established for `returnStateLabel`,
 * `cityGuidanceFromProviders`, etc.
 *
 * No Option/OptionValue table: `ProductVariation.attributes: Json` already
 * fully represents "Couleur: Noir, Taille: M" and is what WooCommerce/
 * Shopify sync also writes — the smallest clean model for this is exactly
 * that existing field, generated from a plain in-memory option list here.
 */

export interface VariationOption {
  name: string;
  values: string[];
}

/**
 * Deterministic cartesian product of every option's values, in the order
 * the options and values were given (Couleur first, then Taille within
 * each colour — matching the worked example in the spec). Duplicate values
 * within one option are de-duplicated (case/whitespace-insensitive) so a
 * typo'd repeat never doubles the combination count.
 */
export function generateAttributeCombinations(options: VariationOption[]): Record<string, string>[] {
  const cleaned = options
    .map((o) => ({ name: o.name.trim(), values: dedupeValues(o.values) }))
    .filter((o) => o.name.length > 0 && o.values.length > 0);
  if (cleaned.length === 0) return [];

  let combos: Record<string, string>[] = [{}];
  for (const option of cleaned) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const value of option.values) {
        next.push({ ...combo, [option.name]: value });
      }
    }
    combos = next;
  }
  return combos;
}

function dedupeValues(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * A stable key for comparing two attribute sets regardless of key order —
 * "already exists" / "still wanted" diffing (the combination generator
 * must never duplicate or silently drop an existing variation) all go
 * through this, never a raw JSON.stringify of the object as stored (whose
 * key order isn't guaranteed to match what the generator produces).
 */
export function attributesKey(attributes: Record<string, unknown>): string {
  return Object.entries(attributes)
    .map(([k, v]) => [k.trim().toLowerCase(), String(v).trim().toLowerCase()] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

/** "Chaussures Homme" → "CHAUSSURES-HOMME"-style fold, reused by the SKU
 * suggestion below — accent-stripped, uppercased, non-alphanumerics → "-". */
function skuFold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * SKU *suggestion* only (Batch 4, Task 6) — never forced, always editable,
 * server-side uniqueness (`assertSkuFreeOfBarcodeAndSiblings`) remains the
 * real authority. Built from the product's own reference (or name, if no
 * reference is set) plus each option VALUE as written (e.g. "Noir" stays
 * "NOIR") — deliberately not translated/abbreviated (e.g. no "Noir" → "BLK"
 * dictionary): a fixed colour-name-to-abbreviation table would be an
 * invented business rule with no basis in the existing code, and would
 * silently break for any option value outside that table (sizes, "Style",
 * "Matière", a colour name in Arabic, ...). The literal value keeps the
 * suggestion correct for every product, at the cost of a slightly longer
 * SKU than a hand-abbreviated one — the user can always edit it down.
 */
export function suggestVariationSku(productReference: string | null | undefined, attributes: Record<string, string>): string {
  const base = skuFold(productReference?.trim() || "");
  const parts = Object.values(attributes)
    .map((v) => skuFold(v))
    .filter(Boolean);
  return [base, ...parts].filter(Boolean).join("-");
}
