import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-12";

export const abonnementArticles: DocArticle[] = [
  {
    slug: "abonnement/comprendre-votre-forfait",
    title: "Comprendre votre forfait",
    category: "abonnement",
    tagline: "Deux forfaits — Business et Pro — chacun avec ses propres limites et fonctionnalités.",
    permission: "settings.view",
    steps: [
      "Ouvrir Paramètres → Abonnement & Utilisation pour voir votre forfait actuel, votre utilisation ce mois-ci, et les fonctionnalités incluses.",
    ],
    whatYouShouldSee: "Le nom de votre forfait, son prix mensuel, la période en cours, et trois indicateurs d'utilisation (commandes, utilisateurs, entrepôts).",
    body: [
      {
        type: "table",
        headers: ["", "Business", "Pro"],
        rows: [
          ["Installation (unique)", "1 500 DH", "2 500 DH"],
          ["Abonnement mensuel", "599 DH / mois", "1 000 DH / mois"],
          ["Commandes / mois (environ)", "1 500", "7 000"],
          ["Utilisateurs actifs", "7", "20"],
          ["Entrepôts actifs", "3", "10"],
          ["WooCommerce & Shopify", "Inclus", "Inclus"],
          ["Rapports", "Standard", "Avancé"],
          ["Rentabilité", "Standard", "Avancé"],
          ["Sauvegarde", "Standard", "Avancé"],
          ["Support", "Standard", "Prioritaire"],
        ],
      },
      {
        type: "callout",
        tone: "info",
        title: "Le forfait Business reste un produit complet",
        text: "La différence entre Business et Pro est d'abord une question de capacité (plus de commandes, d'utilisateurs, d'entrepôts) et de niveau de service — pas de fonctionnalités bridées. Aucune fonctionnalité déjà disponible n'a été retirée du forfait Business.",
      },
    ],
    related: ["abonnement/comprendre-l-utilisation", "abonnement/mettre-a-niveau"],
    tryNow: { label: "Ouvrir Abonnement & Utilisation", href: "/parametres/abonnement" },
    lastUpdated: LAST_UPDATED,
    keywords: ["forfait business", "forfait pro", "prix", "tarifs", "plan"],
  },
  {
    slug: "abonnement/comprendre-l-utilisation",
    title: "Comprendre l'utilisation et les limites",
    category: "abonnement",
    tagline: "Trois indicateurs — commandes, utilisateurs, entrepôts — chacun comparé à la limite de votre forfait.",
    permission: "settings.view",
    body: [
      {
        type: "p",
        text: "Les commandes sont comptées par mois calendaire : chaque commande créée manuellement, importée depuis WooCommerce/Shopify (synchronisation ou webhook), compte une seule fois, pour le mois de sa date réelle de commande — pas la date d'importation. Importer un historique ancien n'augmente donc jamais votre utilisation du mois en cours.",
      },
      {
        type: "p",
        text: "Les utilisateurs et les entrepôts sont comptés à l'instant présent (pas par mois) : seuls les comptes utilisateurs actifs et les entrepôts actifs comptent. Désactiver un utilisateur ou un entrepôt libère immédiatement sa place.",
      },
      {
        type: "callout",
        tone: "info",
        title: "Les commandes ne bloquent jamais la prise de commande",
        text: "Dépasser votre quota mensuel de commandes ne vous empêche jamais de créer une nouvelle commande — c'est votre activité, elle ne doit jamais être interrompue. Vous verrez simplement une alerte vous invitant à passer à un forfait supérieur.",
      },
      {
        type: "callout",
        tone: "warning",
        title: "Les utilisateurs et entrepôts sont des limites strictes",
        text: "Inviter un nouvel utilisateur ou créer un nouvel entrepôt au-delà de la limite de votre forfait est refusé, avec un message clair et un lien vers le forfait supérieur. Les comptes et entrepôts déjà existants ne sont jamais désactivés.",
      },
    ],
    troubleshooting: [
      {
        symptom: "« Votre forfait est limité à 7 utilisateurs actifs (7/7 déjà utilisés). Passez à un forfait supérieur pour en ajouter. »",
        cause: "Le nombre d'utilisateurs actifs de l'entreprise a atteint la limite du forfait.",
        check: "Utilisateurs → vérifier s'il existe un compte désactivé pouvant être réactivé ou remplacé, ou envisager une mise à niveau.",
        solution: "Désactivez un compte inutilisé, ou demandez une mise à niveau depuis Paramètres → Abonnement & Utilisation.",
        expectedResult: "L'invitation ou l'entrepôt peut être créé une fois sous la limite.",
        errorStrings: ["Votre forfait est limité à"],
      },
    ],
    related: ["abonnement/comprendre-votre-forfait", "abonnement/seuils-et-alertes"],
    tryNow: { label: "Ouvrir Abonnement & Utilisation", href: "/parametres/abonnement" },
    lastUpdated: LAST_UPDATED,
    keywords: ["quota", "limite de commandes", "limite d'utilisateurs", "limite d'entrepôts"],
  },
  {
    slug: "abonnement/seuils-et-alertes",
    title: "Que se passe-t-il à 80%, 90% et 100% ?",
    category: "abonnement",
    tagline: "Une alerte progressive — jamais une coupure brutale.",
    permission: "settings.view",
    body: [
      {
        type: "table",
        headers: ["Utilisation", "État", "Ce qui se passe"],
        rows: [
          ["0 – 79%", "🟢 Normal", "Rien de particulier."],
          ["80 – 89%", "🟠 Vous approchez de la limite", "Une notification apparaît ; l'utilisation reste possible normalement."],
          ["90 – 99%", "🔴 Critique", "Une nouvelle notification (plus visible) ; toujours aucun blocage pour les commandes."],
          ["100%+", "⚫ Limite atteinte", "Pour les commandes : toujours aucun blocage. Pour les utilisateurs/entrepôts : toute nouvelle création est refusée jusqu'à mise à niveau ou libération d'une place."],
        ],
      },
      {
        type: "callout",
        tone: "info",
        title: "Une seule alerte par seuil",
        text: "Vous ne recevez pas la même alerte à chaque rafraîchissement de page — chaque seuil (80/90/100%) ne notifie qu'une fois par période. Les alertes apparaissent dans la cloche de notifications, en haut de l'application.",
      },
    ],
    related: ["abonnement/comprendre-l-utilisation", "abonnement/mettre-a-niveau"],
    lastUpdated: LAST_UPDATED,
    keywords: ["80%", "90%", "100%", "seuil", "alerte d'utilisation"],
  },
  {
    slug: "abonnement/mettre-a-niveau",
    title: "Passer à un forfait supérieur",
    category: "abonnement",
    tagline: "Une demande transmise à notre équipe — aucun paiement en ligne automatique n'existe aujourd'hui.",
    permission: "settings.manage",
    steps: [
      "Ouvrir Paramètres → Abonnement & Utilisation.",
      "Cliquer sur « Passer à PRO » (ou « Voir le forfait PRO » si affiché suite à une alerte d'utilisation).",
      "Votre demande est enregistrée et transmise à notre équipe, qui vous recontacte pour finaliser le changement.",
    ],
    whatYouShouldSee: "Un message de confirmation : « Votre demande a été envoyée. Notre équipe vous contactera rapidement. »",
    body: [
      {
        type: "callout",
        tone: "info",
        title: "Le changement de forfait est effectué par un administrateur de la plateforme",
        text: "Une fois votre demande reçue et l'accord commercial finalisé, un administrateur de la plateforme applique le changement de forfait depuis son propre espace d'administration — vous ne pouvez pas modifier votre forfait vous-même.",
      },
    ],
    related: ["abonnement/comprendre-votre-forfait", "abonnement/administration-des-forfaits"],
    tryNow: { label: "Ouvrir Abonnement & Utilisation", href: "/parametres/abonnement" },
    lastUpdated: LAST_UPDATED,
    keywords: ["upgrade", "passer à pro", "changer de forfait", "mise à niveau"],
  },
  {
    slug: "abonnement/apres-un-changement-de-forfait",
    title: "Que se passe-t-il après un changement de forfait (notamment une baisse) ?",
    category: "abonnement",
    tagline: "Aucune donnée n'est jamais supprimée à cause d'un changement de forfait.",
    body: [
      {
        type: "p",
        text: "Si votre entreprise a plus d'utilisateurs actifs ou d'entrepôts actifs que la nouvelle limite du forfait ne le permet, tout reste intact : aucun compte ni entrepôt n'est désactivé ou supprimé automatiquement. Seule la création de NOUVEAUX utilisateurs ou entrepôts est bloquée, jusqu'à ce que l'utilisation redescende sous la limite (en désactivant un compte, par exemple) ou qu'un forfait supérieur soit à nouveau choisi.",
      },
      {
        type: "callout",
        tone: "warning",
        title: "Exemple",
        text: "Une entreprise avec 20 utilisateurs passe du forfait Pro (20 utilisateurs) au forfait Business (7 utilisateurs). Les 20 comptes restent actifs et fonctionnels. Inviter un 21ᵉ utilisateur est refusé tant que l'entreprise reste sur Business avec plus de 7 comptes actifs.",
      },
    ],
    related: ["abonnement/comprendre-l-utilisation", "abonnement/administration-des-forfaits"],
    lastUpdated: LAST_UPDATED,
    keywords: ["downgrade", "baisse de forfait", "rétrogradation"],
  },
  {
    slug: "abonnement/fonctionnalite-indisponible",
    title: "Pourquoi une fonctionnalité peut être indisponible",
    category: "abonnement",
    tagline: "Deux raisons possibles : une permission de rôle, ou une fonctionnalité non incluse dans le forfait.",
    body: [
      {
        type: "p",
        text: "Deux vérifications indépendantes s'appliquent à chaque action : votre RÔLE (ce que votre compte est autorisé à faire — voir Utilisateurs & permissions) et le FORFAIT de votre entreprise (ce que ce forfait inclut). Les deux doivent être satisfaites.",
      },
      {
        type: "p",
        text: "Aujourd'hui, les forfaits Business et Pro incluent les mêmes fonctionnalités de base (WooCommerce, Shopify, IA, intégrations, commissions, finance) — seuls les niveaux de Rapports, Rentabilité et Sauvegarde diffèrent (Standard sur Business, Avancé sur Pro). Si un message indique qu'une fonctionnalité n'est pas incluse dans votre forfait, contactez votre administrateur ou consultez Paramètres → Abonnement & Utilisation.",
      },
    ],
    related: ["abonnement/comprendre-votre-forfait", "utilisateurs/comprendre-les-roles"],
    lastUpdated: LAST_UPDATED,
    keywords: ["fonctionnalité non disponible", "entitlement", "accès refusé forfait"],
  },
  {
    slug: "abonnement/administration-des-forfaits",
    title: "Comment les administrateurs de la plateforme gèrent les forfaits",
    category: "abonnement",
    tagline: "Réservé aux administrateurs de la plateforme (/platform) — un propriétaire de boutique ne peut pas modifier son propre forfait.",
    body: [
      {
        type: "p",
        text: "Depuis /platform, un administrateur de la plateforme voit chaque tenant, son forfait, son statut d'abonnement, son utilisation et son état (normal / approche de la limite / critique / limite atteinte). Le bouton « Gérer le forfait » sur chaque ligne permet de changer le forfait d'un tenant et son statut d'abonnement (actif / essai / paiement en retard / résilié).",
      },
      {
        type: "callout",
        tone: "warning",
        title: "Le statut d'abonnement n'est pas le statut du tenant",
        text: "Le statut d'abonnement (facturation) est indépendant du statut du tenant (actif/suspendu, qui contrôle l'accès à l'application). Un tenant en retard de paiement peut rester accessible tant qu'il n'est pas explicitement suspendu — ce sont deux décisions distinctes.",
      },
      {
        type: "p",
        text: "Depuis /platform/plans, un administrateur de la plateforme peut modifier les prix, les limites et les fonctionnalités de chaque forfait — un changement s'applique immédiatement à tous les tenants sur ce forfait. Chaque changement de forfait ou d'abonnement est enregistré dans le journal d'audit du tenant concerné, avec l'identité de l'administrateur et l'horodatage.",
      },
    ],
    related: ["abonnement/apres-un-changement-de-forfait", "abonnement/comprendre-votre-forfait"],
    tryNow: { label: "Ouvrir la plateforme", href: "/platform" },
    lastUpdated: LAST_UPDATED,
    keywords: ["platform admin", "gérer un forfait", "changer de forfait tenant", "administration plateforme"],
  },
];
