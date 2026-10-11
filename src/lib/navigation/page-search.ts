/**
 * « Pages » in the global search: the destinations a user may open, matched
 * by name without caring about case or accents (« depenses » finds
 * « Dépenses », « suivi colis » finds « Suivi »). Pure — the candidate list
 * is already permission-filtered by the caller (src/actions/search.ts).
 */
export interface PageDestination {
  href: string;
  label: string;
  /** The sidebar group or « Rapports » — searchable and shown as context. */
  group: string;
}

export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Every word of the query must start a word of the label or the group (« fac
 * liv » → « Factures de livraison »). Label-start matches rank first, then
 * the list's own order (the sidebar's), so results are stable.
 */
export function matchPages<T extends PageDestination>(pages: readonly T[], query: string, limit = 6): T[] {
  const words = normalizeForSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const scored: { page: T; score: number; index: number }[] = [];
  pages.forEach((page, index) => {
    const label = normalizeForSearch(page.label).split(" ");
    const haystack = [...label, ...normalizeForSearch(page.group).split(" ")];
    if (!words.every((w) => haystack.some((h) => h.startsWith(w)))) return;
    scored.push({ page, score: label[0]?.startsWith(words[0]!) ? 0 : 1, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.page);
}
