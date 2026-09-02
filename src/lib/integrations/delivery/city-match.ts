import "server-only";

/**
 * Provider-agnostic city-name matching — used by any adapter that resolves
 * a local free-text city against a carrier's own destination catalogue
 * (today: OzonExpress's `resolveCity`, `src/lib/integrations/delivery/
 * providers/ozonexpress/mapper.ts`) and by the connection-test diagnostic
 * in `service.ts` that surfaces unresolved/ambiguous local order cities to
 * the operator. See docs/adr/0013-ozonexpress-integration.md's city
 * resolution hardening (Phase 27B).
 *
 * The one rule every function here exists to enforce: normalize away
 * *harmless* differences (case, incidental whitespace, accents), never
 * anything that could conflate two genuinely different places, and never
 * pick a "closest" match automatically — ambiguity and no-match are always
 * reported, never silently resolved.
 */

/**
 * Normalizes a city name for comparison: strips diacritics (so "Fès" and
 * "Fes" compare equal), trims, collapses internal whitespace runs to a
 * single space, and lowercases. Deliberately does NOT touch hyphens,
 * apostrophes, or other punctuation — "Sidi Bennour" and "Sidi-Bennour"
 * are left distinct rather than guessed equal, since Moroccan place names
 * routinely differ by exactly that and conflating them risks silently
 * matching the wrong destination.
 */
const COMBINING_MARK_PATTERN = /\p{Mark}/gu;

export function normalizeCityName(name: string): string {
  return name
    .normalize("NFD") // decompose accented letters into base + combining mark
    .replace(COMBINING_MARK_PATTERN, "") // then drop the marks, e.g. "Fès" -> "Fes"
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export interface CityMatchCandidate {
  id: string;
  name: string;
}

export type CityMatchResult =
  | { outcome: "resolved"; id: string; name: string }
  | { outcome: "ambiguous"; candidates: CityMatchCandidate[] }
  | { outcome: "unresolved"; suggestions: CityMatchCandidate[] };

/**
 * Matches `localName` against `catalogue` by normalized-name equality.
 * - Exactly one normalized match → `resolved`.
 * - More than one (the catalogue has two entries that normalize the same,
 *   or coincidentally share a name) → `ambiguous`, every match listed —
 *   never guesses which one was meant.
 * - Zero exact matches → `unresolved`, with up to 5 substring-based near
 *   misses as `suggestions` (informational only, e.g. to help an operator
 *   write a correct manual override) — a suggestion is never treated as a
 *   match.
 */
export function matchCityName(
  localName: string,
  catalogue: readonly CityMatchCandidate[]
): CityMatchResult {
  const target = normalizeCityName(localName);

  const exact = catalogue.filter((c) => normalizeCityName(c.name) === target);
  if (exact.length === 1) {
    return { outcome: "resolved", id: exact[0].id, name: exact[0].name };
  }
  if (exact.length > 1) {
    return { outcome: "ambiguous", candidates: exact };
  }

  const suggestions = catalogue
    .filter((c) => {
      const n = normalizeCityName(c.name);
      return n.length > 0 && target.length > 0 && (n.includes(target) || target.includes(n));
    })
    .slice(0, 5);
  return { outcome: "unresolved", suggestions };
}
