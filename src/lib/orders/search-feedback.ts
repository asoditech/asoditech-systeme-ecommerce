/**
 * The « x résultats / aucun résultat » line under the /commandes search.
 * `null` without a search term. The default month scope is named when it
 * hides everything, so an empty answer is never a silent dead end.
 */
export function orderSearchFeedback(params: { q: string | null | undefined; total: number; scopedToThisMonth: boolean }): string | null {
  const q = params.q?.trim();
  if (!q) return null;
  if (params.total === 0) {
    return params.scopedToThisMonth
      ? `Aucun résultat pour « ${q} » ce mois-ci — essayez « Toute la période ».`
      : `Aucun résultat pour « ${q} ».`;
  }
  return `${params.total} résultat${params.total > 1 ? "s" : ""} pour « ${q} »${params.scopedToThisMonth ? " ce mois-ci" : ""}.`;
}
