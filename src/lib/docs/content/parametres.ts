import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-10";

export const parametresArticles: DocArticle[] = [
  {
    slug: "parametres/parametres-boutique",
    title: "Paramètres boutique",
    category: "parametres",
    tagline: "Les informations générales de votre entreprise, utilisées sur les documents imprimés (factures, relevés).",
    permission: "settings.view",
    steps: [
      "Ouvrir Paramètres.",
      "Renseigner le nom de l'entreprise, les coordonnées, le logo.",
      "Enregistrer (nécessite la permission de gestion des paramètres).",
    ],
    troubleshooting: [
      {
        symptom: "« Vous n'avez pas la permission de modifier les paramètres. »",
        cause: "Votre rôle a accès en lecture aux paramètres mais pas en modification.",
        check: "Seuls OWNER/ADMIN ont la permission de modification des paramètres.",
        solution: "Demandez à un OWNER/ADMIN d'effectuer la modification.",
        expectedResult: "—",
        errorStrings: ["Vous n'avez pas la permission de modifier les paramètres."],
      },
    ],
    related: ["parametres/organisation-des-parametres"],
    tryNow: { label: "Ouvrir Paramètres", href: "/parametres" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "parametres/organisation-des-parametres",
    title: "Où trouver chaque réglage",
    category: "parametres",
    tagline: "Utilisateurs, Intégrations et Livraison ne sont pas des sous-pages de Paramètres — chacun a sa propre page dans le menu.",
    body: [
      {
        type: "table",
        headers: ["Réglage", "Se trouve dans"],
        rows: [
          ["Informations de l'entreprise", "Paramètres → Général"],
          ["Sauvegarde et Google Drive", "Paramètres → Sauvegarde & Portabilité"],
          ["Utilisateurs, rôles, invitations", "menu Utilisateurs"],
          ["WooCommerce, Shopify, webhooks", "menu Intégrations"],
          ["Transporteurs, villes, correspondances", "menu Livraison → Prestataires"],
        ],
      },
    ],
    related: ["utilisateurs/invitation", "integrations/connecter-woocommerce", "livraison/transporteurs", "sauvegarde/backup-local"],
    lastUpdated: LAST_UPDATED,
    keywords: ["où sont les paramètres", "réglages"],
  },
];
