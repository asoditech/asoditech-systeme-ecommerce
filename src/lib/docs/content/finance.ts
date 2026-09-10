import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-10";

export const financeArticles: DocArticle[] = [
  {
    slug: "finance/coup-produit",
    title: "Coût produit",
    category: "finance",
    tagline: "Le coût d'achat est la base de tout calcul de marge et de rentabilité — voir « Coûts » côté Produits pour le renseigner.",
    permission: "finance.view",
    related: ["produits/couts", "finance/marge"],
    tryNow: { label: "Ouvrir Finance", href: "/finance" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "finance/marge",
    title: "Marge",
    category: "finance",
    tagline: "La marge se calcule toujours à partir du coût réellement figé au moment de la vente, jamais du coût actuel du produit.",
    permission: "finance.view",
    body: [
      {
        type: "p",
        text: "Deux notions distinctes coexistent : la marge prévisionnelle (au prix et coût d'aujourd'hui, utile pour décider d'un futur prix) et la marge réalisée sur une vente passée (basée sur le coût figé — le « snapshot » — au moment de cette vente).",
      },
    ],
    related: ["produits/snapshots-des-couts", "finance/rentabilite"],
    tryNow: { label: "Ouvrir Finance", href: "/finance" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "finance/depenses",
    title: "Dépenses",
    category: "finance",
    tagline: "Enregistrer les charges de l'entreprise (loyer, publicité, salaires…) pour qu'elles soient déduites du bénéfice net.",
    permission: "finance.manage",
    steps: [
      "Ouvrir Dépenses → Nouvelle dépense.",
      "Choisir une catégorie (les catégories sont libres, créées au fil des besoins), renseigner le fournisseur, le montant et la date.",
      "Enregistrer.",
    ],
    body: [
      { type: "p", text: "Le total des charges affiché combine les dépenses enregistrées ET le coût de livraison réel de la période — les deux sont déduits du chiffre d'affaires pour obtenir le bénéfice net." },
    ],
    related: ["finance/rentabilite", "rapports/tresorerie"],
    tryNow: { label: "Ouvrir Dépenses", href: "/depenses" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "finance/rentabilite",
    title: "Rentabilité",
    category: "finance",
    tagline: "Le tableau de la rentabilité réelle : chiffre d'affaires, coût des ventes, marge brute, charges, bénéfice net.",
    permission: "finance.view",
    prerequisites: ["Le coût d'achat des produits vendus doit être renseigné pour un calcul complet."],
    body: [
      {
        type: "p",
        text: "Les commandes Annulées, en Échec, en Retour ou Remboursées ne comptent jamais dans le chiffre d'affaires ni dans le coût des ventes. Une commande annulée n'entraîne jamais de coût de livraison ; un retour ou un échec applique un coût de livraison spécifique, distinct du coût normal.",
      },
    ],
    troubleshooting: [
      {
        symptom: "Le bénéfice net affiche « Non calculable »",
        cause: "Une ou plusieurs ventes de la période n'ont pas de coût d'achat renseigné (coût manquant).",
        check: "Consultez le détail — les commandes ou produits concernés sont signalés.",
        solution: "Voir « Pourquoi une vente peut afficher Coût manquant » puis « Application rétroactive du coût ».",
        expectedResult: "Le bénéfice net devient calculable une fois tous les coûts renseignés et appliqués.",
      },
    ],
    related: ["finance/pourquoi-cout-manquant", "rapports/rentabilite-produit"],
    tryNow: { label: "Ouvrir Finance", href: "/finance" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "finance/pourquoi-cout-manquant",
    title: "Pourquoi une vente peut afficher « Coût manquant »",
    category: "finance",
    tagline: "Le coût utilisé pour la rentabilité est celui figé au moment de la vente — s'il n'existait pas alors, la vente reste « coût manquant ».",
    permission: "finance.view",
    troubleshooting: [
      {
        symptom: "« coût manquant » sur une commande, un produit, un rapport ou le tableau de bord",
        cause: "Le produit (ou sa variation) n'avait pas de coût d'achat renseigné au moment de cette vente précise.",
        check: "Ouvrez la fiche du produit concerné et vérifiez si un coût y est renseigné aujourd'hui.",
        solution: "Renseignez le coût sur le produit, puis utilisez « Appliquer le coût rétroactivement » pour corriger les ventes passées concernées.",
        expectedResult: "La rentabilité de ces ventes devient calculable.",
        errorStrings: ["Coût manquant", "coût manquant", "Coût d'achat manquant sur certains produits", "sans coût d'achat renseigné"],
      },
    ],
    related: ["finance/application-retroactive-du-cout", "produits/snapshots-des-couts"],
    tryNow: { label: "Ouvrir Finance", href: "/finance" },
    lastUpdated: LAST_UPDATED,
    keywords: ["coût manquant"],
  },
  {
    slug: "finance/application-retroactive-du-cout",
    title: "Application rétroactive du coût",
    category: "finance",
    tagline: "Combler le coût manquant de ventes passées avec le coût actuel du produit, sans toucher aux ventes qui avaient déjà un coût.",
    permission: "products.edit",
    steps: [
      "Renseignez d'abord le coût d'achat actuel sur le produit (et ses variations si besoin).",
      "Depuis la fiche produit, utilisez « Appliquer le coût rétroactivement ».",
    ],
    body: [
      { type: "p", text: "Seules les ventes sans coût sont concernées — celles qui en avaient déjà un gardent le leur. Les commandes Annulées, en Échec, en Retour ou Remboursées ne sont jamais concernées." },
    ],
    related: ["produits/snapshots-des-couts", "finance/impact-sur-le-benefice"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "finance/impact-sur-le-benefice",
    title: "Impact sur le bénéfice",
    category: "finance",
    tagline: "Comprendre pourquoi appliquer un coût rétroactivement change le bénéfice affiché de périodes déjà passées.",
    permission: "finance.view",
    body: [
      {
        type: "callout",
        tone: "warning",
        text: "L'application rétroactive d'un coût modifie réellement la rentabilité historique affichée — c'est volontaire et explicite (une action manuelle, jamais automatique), car c'est la seule façon de corriger une vente passée sans coût.",
      },
    ],
    related: ["finance/application-retroactive-du-cout"],
    tryNow: { label: "Ouvrir Finance", href: "/finance" },
    lastUpdated: LAST_UPDATED,
  },
];
