/**
 * Store-sale product search failures, as the seller should read them
 * (src/components/sales/sale-form.tsx). Server-side the search is unchanged:
 * `lookupForSaleAction` keeps every permission / channel / location check.
 * `searchForSaleAction` only CLASSIFIES its failure — production builds hide
 * a thrown error's message from the browser, so the reason has to come back
 * as data — and the form shows it instead of the page's error screen.
 */
export type SaleLookupFailure = "session" | "permission" | "channel" | "location" | "unexpected";

export const SALE_LOOKUP_MESSAGES: Record<SaleLookupFailure | "stale", string> = {
  session: "Votre session a expiré. Rechargez la page et reconnectez-vous.",
  permission: "Accès refusé : vous n'avez pas le droit de vendre en magasin. Demandez à votre responsable de vérifier vos accès.",
  channel: "Accès refusé : ce canal de vente ne vous est pas attribué. Demandez à votre responsable de vérifier vos accès (Utilisateurs → Accès).",
  location: "Accès refusé : cet emplacement ne vous est pas attribué. Demandez à votre responsable de vérifier vos accès (Utilisateurs → Emplacements).",
  unexpected: "La recherche d'articles a échoué. Réessayez ; si le problème persiste, rechargez la page.",
  stale: "La page n'est plus à jour (nouvelle version de l'application). Rechargez la page pour continuer.",
};

/** Maps an authorization error thrown by the server guards to a failure kind; null = not an authorization error. */
export function classifySaleLookupError(error: unknown): SaleLookupFailure | null {
  const message = error instanceof Error ? error.message : "";
  if (!/^Non autorisé/.test(message)) return null;
  if (/session/i.test(message)) return "session";
  if (/emplacement/i.test(message)) return "location";
  if (/canal/i.test(message)) return "channel";
  return "permission";
}
