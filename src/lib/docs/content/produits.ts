import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-10";

export const produitsArticles: DocArticle[] = [
  {
    slug: "produits/comprendre-les-produits",
    title: "Comprendre les produits",
    category: "produits",
    tagline: "Un produit peut venir de WooCommerce, de Shopify, ou être créé directement dans ASODITECH.",
    permission: "products.view",
    body: [
      {
        type: "p",
        text: "Chaque produit a un statut : Actif (vendable), Brouillon (en préparation, non vendable), ou Archivé (retiré du catalogue mais son historique de ventes reste intact).",
      },
      {
        type: "p",
        text: "Un produit importé (WooCommerce/Shopify) affiche sa plateforme d'origine. Sa fiche (nom, prix, description) ne peut être modifiée que sur la plateforme d'origine — seuls le coût d'achat et les réglages de stock restent modifiables dans ASODITECH.",
      },
    ],
    related: ["produits/produits-simples", "produits/produits-variables", "integrations/synchronisation-produits"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "produits/produits-simples",
    title: "Produits simples",
    category: "produits",
    tagline: "Un produit sans variation : un seul prix, un seul coût, un seul niveau de stock par entrepôt.",
    permission: "products.create",
    prerequisites: [],
    steps: [
      "Ouvrir Produits → Nouveau produit.",
      "Renseigner le nom, le SKU (unique dans votre compte), le prix de vente et, si connu, le coût d'achat.",
      "Enregistrer — un enregistrement de stock est automatiquement disponible pour l'entrepôt par défaut.",
    ],
    troubleshooting: [
      {
        symptom: "« Un produit avec ce SKU existe déjà. »",
        cause: "Le SKU saisi est déjà utilisé par un autre produit dans votre compte (le SKU doit être unique par entreprise, pas globalement).",
        check: "Recherchez le SKU dans Produits.",
        solution: "Choisissez un SKU différent, ou modifiez le produit existant si c'est bien le même article.",
        expectedResult: "Le produit est créé.",
        errorStrings: ["Un produit avec ce SKU existe déjà."],
      },
    ],
    related: ["produits/produits-variables", "produits/prix"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "produits/produits-variables",
    title: "Produits variables et variations",
    category: "produits",
    tagline: "Un produit variable regroupe plusieurs variations (ex. Couleur/Taille), chacune avec son propre prix, coût et stock.",
    permission: "products.create",
    steps: [
      "Créer le produit parent (nom, description, catégorie).",
      "Ajouter les variations : chaque variation porte ses propres attributs (ex. Couleur: Rouge, Taille: M).",
      "Chaque variation peut avoir son propre prix et coût — s'ils ne sont pas renseignés, ceux du produit parent sont utilisés à la vente.",
    ],
    body: [
      {
        type: "callout",
        tone: "info",
        text: "Une variation n'est jamais un produit séparé dans les listes — elle reste rattachée à son produit parent, y compris lors d'une synchronisation WooCommerce/Shopify.",
      },
    ],
    commonMistakes: ["Chercher une variation dans la liste Produits comme si c'était un produit indépendant."],
    related: ["produits/prix", "produits/couts", "produits/stock-produit"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "produits/prix",
    title: "Prix",
    category: "produits",
    tagline: "Le prix de vente (et un prix promotionnel optionnel) déterminent ce que paie le client.",
    permission: "products.edit",
    body: [
      { type: "p", text: "Un prix promotionnel ne peut jamais dépasser le prix normal du produit." },
    ],
    troubleshooting: [
      {
        symptom: "« Le prix promotionnel ne peut pas dépasser le prix normal. »",
        cause: "Le prix promotionnel saisi est supérieur au prix normal.",
        check: "Comparez les deux valeurs saisies.",
        solution: "Corrigez le prix promotionnel pour qu'il soit inférieur ou égal au prix normal.",
        expectedResult: "L'enregistrement réussit.",
        errorStrings: ["Le prix promotionnel ne peut pas dépasser le prix normal."],
      },
    ],
    related: ["produits/couts"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "produits/couts",
    title: "Coûts",
    category: "produits",
    tagline: "Le coût d'achat d'un produit alimente directement le calcul de marge et de rentabilité — sans lui, le bénéfice ne peut pas être calculé.",
    permission: "products.edit",
    prerequisites: [],
    steps: [
      "Ouvrir la fiche du produit (ou de la variation).",
      "Renseigner le coût d'achat.",
      "Enregistrer — le coût s'applique dès la prochaine vente (pas aux ventes passées, voir « Snapshots des coûts »).",
    ],
    body: [
      {
        type: "callout",
        tone: "info",
        text: "Le coût d'achat reste modifiable dans ASODITECH même pour un produit importé de WooCommerce/Shopify — c'est un réglage propre à ASODITECH, pas à la boutique d'origine.",
      },
    ],
    related: ["produits/snapshots-des-couts", "finance/coup-produit"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
    keywords: ["coût manquant", "coût d'achat"],
  },
  {
    slug: "produits/snapshots-des-couts",
    title: "Snapshots des coûts",
    category: "produits",
    tagline: "Le coût utilisé pour la rentabilité d'une commande est celui figé au moment de la vente, pas le coût actuel du produit.",
    permission: "products.edit",
    body: [
      {
        type: "p",
        text: "À chaque vente, ASODITECH enregistre le coût du produit (ou de la variation) tel qu'il était à cet instant précis — ce « snapshot » ne change plus jamais, même si vous modifiez le coût du produit plus tard. C'est ce qui garantit que la rentabilité d'une commande passée reste historiquement exacte.",
      },
      {
        type: "callout",
        tone: "warning",
        title: "Conséquence pratique",
        text: "Si le coût n'était pas renseigné au moment de la vente, cette vente restera « coût manquant » même après avoir renseigné le coût aujourd'hui.",
      },
    ],
    steps: [
      "Pour les ventes passées sans coût, ouvrir la fiche produit.",
      "Renseigner d'abord le coût d'achat actuel du produit (ou de ses variations).",
      "Utiliser l'action « Appliquer le coût rétroactivement » — elle remplit le coût des ventes passées qui n'en avaient pas, avec le coût actuel.",
    ],
    whatYouShouldSee: "Les commandes concernées, non annulées/retournées, affichent désormais un coût et une marge calculables.",
    troubleshooting: [
      {
        symptom: "« Renseignez d'abord le coût d'achat du produit. »",
        cause: "Vous essayez d'appliquer rétroactivement un coût alors qu'aucun coût n'est renseigné ni sur le produit ni sur ses variations.",
        check: "Vérifiez la fiche produit.",
        solution: "Renseignez le coût d'achat du produit (ou de chaque variation concernée), puis relancez l'application rétroactive.",
        expectedResult: "Les ventes passées sans coût sont mises à jour avec le coût actuel.",
        errorStrings: ["Renseignez d'abord le coût d'achat du produit."],
      },
      {
        symptom: "Une vente reste « coût manquant » après avoir renseigné le coût aujourd'hui",
        cause: "Le coût n'a pas encore été appliqué rétroactivement à cette vente précise.",
        check: "Vérifiez si l'action « Appliquer le coût rétroactivement » a été exécutée après avoir renseigné le coût.",
        solution: "Utilisez « Appliquer le coût rétroactivement » depuis la fiche produit.",
        expectedResult: "La vente affiche désormais un coût et une marge.",
      },
    ],
    related: ["finance/pourquoi-cout-manquant", "finance/application-retroactive-du-cout"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
    keywords: ["coût manquant", "rétroactivité", "backfill"],
  },
  {
    slug: "produits/stock-produit",
    title: "Stock produit",
    category: "produits",
    tagline: "Le stock d'un produit se gère par entrepôt — un même produit peut avoir des quantités différentes selon l'entrepôt.",
    permission: "inventory.view",
    body: [
      {
        type: "p",
        text: "Le « suivi de stock » (activé par défaut) et le « seuil de stock faible » (5 par défaut) sont des réglages du produit. Les quantités réelles (disponible, réservé) sont gérées dans le module Stock, pas sur la fiche produit elle-même.",
      },
    ],
    related: ["stock/stock-disponible", "stock/produits-sans-stock"],
    tryNow: { label: "Ouvrir Stock", href: "/stock" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "produits/archiver-retirer-du-catalogue",
    title: "Archiver / retirer du catalogue",
    category: "produits",
    tagline: "Retirer un produit du catalogue sans perdre son historique de ventes.",
    permission: "products.edit",
    steps: [
      "Ouvrir la fiche du produit.",
      "Utiliser l'action de retrait/archivage.",
    ],
    body: [
      {
        type: "callout",
        tone: "info",
        text: "Si le produit n'a jamais été vendu, il est supprimé définitivement. S'il a déjà été vendu au moins une fois, il est archivé (jamais supprimé) pour que son historique de ventes reste consultable dans les rapports.",
      },
    ],
    related: ["produits/produits-supprimes-woocommerce-shopify"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "produits/produits-supprimes-woocommerce-shopify",
    title: "Produits supprimés de WooCommerce/Shopify",
    category: "produits",
    tagline: "Un produit supprimé sur la boutique d'origine n'est jamais supprimé dans ASODITECH.",
    permission: "products.view",
    body: [
      {
        type: "p",
        text: "Lorsque WooCommerce ou Shopify signale la suppression d'un produit, ASODITECH l'archive automatiquement (statut « Archivé ») au lieu de le supprimer — son historique de ventes reste donc intact et consultable.",
      },
    ],
    related: ["produits/archiver-retirer-du-catalogue", "integrations/synchronisation-produits"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
    keywords: ["produit supprimé", "produit disparu"],
  },
];
