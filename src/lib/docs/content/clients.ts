import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-10";

export const clientsArticles: DocArticle[] = [
  {
    slug: "clients/creer-gerer-un-client",
    title: "Créer / gérer un client",
    category: "clients",
    tagline: "Un client peut être créé manuellement ou arriver automatiquement avec une commande WooCommerce/Shopify.",
    permission: "customers.create",
    prerequisites: [],
    steps: [
      "Ouvrir Clients → Nouveau client.",
      "Renseigner au minimum le nom complet (2 à 200 caractères).",
      "Renseigner téléphone, WhatsApp, e-mail, ville, région selon les besoins.",
      "Enregistrer.",
    ],
    body: [
      {
        type: "p",
        text: "Un client peut être classé par segment (Nouveau, Actif, Fidèle, À risque, Inactif, VIP) et mis sur liste noire manuellement — ASODITECH ne mets jamais un client sur liste noire automatiquement.",
      },
    ],
    related: ["clients/adresses", "clients/historique-des-commandes"],
    tryNow: { label: "Ouvrir Clients", href: "/clients" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "clients/adresses",
    title: "Adresses",
    category: "clients",
    tagline: "Un client peut avoir plusieurs adresses ; l'une d'elles peut être marquée par défaut.",
    permission: "customers.edit",
    steps: [
      "Ouvrir la fiche du client.",
      "Ajouter une adresse : libellé, adresse (ligne 1 obligatoire), ville (obligatoire), région, pays (Maroc par défaut), téléphone.",
      "Marquer une adresse comme adresse par défaut si besoin.",
    ],
    body: [
      {
        type: "callout",
        tone: "info",
        text: "L'adresse de livraison d'une commande est une copie figée au moment de la commande — la modifier depuis la commande ne modifie pas le carnet d'adresses du client, et inversement.",
      },
    ],
    related: ["commandes/modifier-traiter-une-commande", "livraison/creer-une-expedition"],
    tryNow: { label: "Ouvrir Clients", href: "/clients" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "clients/historique-des-commandes",
    title: "Historique des commandes",
    category: "clients",
    tagline: "La fiche client résume ses statistiques réelles : total dépensé, nombre de commandes, panier moyen, retours, annulations.",
    permission: "customers.view",
    body: [
      {
        type: "p",
        text: "Ces statistiques sont calculées à la lecture, jamais stockées à l'avance — elles reflètent donc toujours l'état actuel des commandes. Les commandes annulées ou en échec ne comptent pas dans le total dépensé.",
      },
    ],
    related: ["clients/clients-recurrents"],
    tryNow: { label: "Ouvrir Clients", href: "/clients" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "clients/clients-recurrents",
    title: "Clients récurrents",
    category: "clients",
    tagline: "ASODITECH reconnaît automatiquement un client qui commande à nouveau depuis une boutique WooCommerce, même en commande invité.",
    permission: "customers.view",
    body: [
      {
        type: "p",
        text: "Lors de l'import d'une commande WooCommerce, la reconnaissance du client se fait dans cet ordre : identifiant client WooCommerce, puis e-mail, puis téléphone. Le téléphone est utilisé en dernier recours car un client qui commande en tant qu'invité (sans créer de compte) garde souvent le même téléphone d'une commande à l'autre, même si l'e-mail change.",
      },
      { type: "p", text: "Le rapport Clients (Rapports → Clients) distingue les nouveaux clients des clients récurrents sur la période choisie." },
    ],
    related: ["rapports/clients"],
    lastUpdated: LAST_UPDATED,
  },
];
