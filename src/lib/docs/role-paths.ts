import type { RolePath } from "./types";

/**
 * §6 "Où dois-je commencer ?" — the exact per-role reading order the spec
 * asked for. This only affects *ordering/emphasis* on the docs home page;
 * every article stays reachable by every logged-in user (see
 * src/lib/docs/types.ts's DocArticle.permission comment).
 */
export const ROLE_PATHS: RolePath[] = [
  {
    role: "OWNER",
    title: "Je suis propriétaire de la boutique",
    slugs: [
      "bien-demarrer/configuration-initiale",
      "integrations/connecter-woocommerce",
      "produits/comprendre-les-produits",
      "commandes/creer-une-commande",
      "stock/entrepots",
      "livraison/transporteurs",
      "finance/rentabilite",
      "rapports/ventes",
      "abonnement/comprendre-votre-forfait",
    ],
  },
  {
    role: "ADMIN",
    title: "Je suis administrateur",
    slugs: [
      "bien-demarrer/configuration-initiale",
      "integrations/connecter-woocommerce",
      "produits/comprendre-les-produits",
      "commandes/creer-une-commande",
      "stock/entrepots",
      "livraison/transporteurs",
      "finance/rentabilite",
      "rapports/ventes",
      "abonnement/comprendre-votre-forfait",
    ],
  },
  {
    role: "MANAGER",
    title: "Je suis manager",
    slugs: [
      "bien-demarrer/comprendre-le-tableau-de-bord",
      "commandes/comprendre-les-statuts",
      "confirmation/workflow-de-confirmation",
      "stock/stock-disponible",
      "livraison/creer-une-expedition",
      "finance/rentabilite",
    ],
  },
  {
    role: "CONFIRMATION",
    title: "Je suis opérateur de confirmation",
    slugs: ["commandes/creer-une-commande", "confirmation/workflow-de-confirmation", "confirmation/causes-frequentes"],
  },
  {
    role: "WAREHOUSE",
    title: "Je suis responsable du stock",
    slugs: ["stock/entrepots", "stock/stock-disponible", "stock/transferts", "stock/inventaire-stocktake"],
  },
  {
    role: "DELIVERY",
    title: "Je suis responsable livraison",
    slugs: [
      "livraison/transporteurs",
      "livraison/villes-et-correspondances",
      "livraison/creer-une-expedition",
      "livraison/suivi",
      "livraison/cycle-de-vie-dune-expedition",
    ],
  },
  {
    role: "SUPPORT",
    title: "Je suis support client",
    slugs: ["clients/creer-gerer-un-client", "clients/historique-des-commandes", "commandes/problemes-frequents"],
  },
  {
    role: "ACCOUNTANT",
    title: "Je suis comptable",
    slugs: ["finance/rentabilite", "finance/pourquoi-cout-manquant", "rapports/tresorerie", "rapports/rentabilite-produit"],
  },
];

export function getRolePath(role: string): RolePath | undefined {
  return ROLE_PATHS.find((p) => p.role === role);
}
