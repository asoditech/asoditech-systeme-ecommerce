import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-10";

function roleArticle(opts: {
  slug: string;
  title: string;
  role: DocArticle["roles"];
  tagline: string;
  permissions: string[];
  notes?: string;
}): DocArticle {
  return {
    slug: opts.slug,
    title: opts.title,
    category: "utilisateurs",
    tagline: opts.tagline,
    roles: opts.role,
    body: [
      { type: "list", items: opts.permissions },
      ...(opts.notes ? [{ type: "p" as const, text: opts.notes }] : []),
    ],
    related: ["utilisateurs/comprendre-les-roles"],
    lastUpdated: LAST_UPDATED,
  };
}

export const utilisateursArticles: DocArticle[] = [
  {
    slug: "utilisateurs/comprendre-les-roles",
    title: "Comprendre les rôles et permissions",
    category: "utilisateurs",
    tagline: "Chaque personne a un rôle unique, qui détermine exactement ce qu'elle peut voir et faire — le rôle se choisit à l'invitation et se change ensuite via Utilisateurs.",
    permission: "users.view",
    body: [
      {
        type: "p",
        text: "Il existe 8 rôles : OWNER, ADMIN, MANAGER, CONFIRMATION, WAREHOUSE, DELIVERY, SUPPORT, ACCOUNTANT. Chaque permission (« voir les commandes », « gérer la livraison »…) est accordée par rôle — il n'existe pas d'éditeur de permissions personnalisées : changer les droits d'un rôle est un choix produit, pas un réglage utilisateur.",
      },
      {
        type: "callout",
        tone: "info",
        text: "OWNER et ADMIN ont accès à tout. Un compte OWNER est protégé : personne d'autre ne peut le désactiver, le supprimer, ni changer son rôle — et seul un OWNER peut créer un autre OWNER.",
      },
    ],
    related: [
      "utilisateurs/role-owner-admin",
      "utilisateurs/role-manager",
      "utilisateurs/role-confirmation",
      "utilisateurs/role-warehouse",
      "utilisateurs/role-delivery",
      "utilisateurs/role-support",
      "utilisateurs/role-accountant",
    ],
    tryNow: { label: "Ouvrir Utilisateurs", href: "/utilisateurs" },
    lastUpdated: LAST_UPDATED,
  },
  roleArticle({
    slug: "utilisateurs/role-owner-admin",
    title: "OWNER et ADMIN",
    role: ["OWNER", "ADMIN"],
    tagline: "Accès complet à tous les modules — le propriétaire (OWNER) est en plus protégé contre toute modification par un autre compte.",
    permissions: [
      "Toutes les permissions du système, sans exception.",
      "Seul un OWNER peut inviter ou promouvoir un autre OWNER.",
      "Un OWNER ne peut être ni désactivé, ni supprimé, ni changé de rôle par qui que ce soit — y compris un autre ADMIN.",
    ],
  }),
  roleArticle({
    slug: "utilisateurs/role-manager",
    title: "MANAGER",
    role: ["MANAGER"],
    tagline: "Accès opérationnel complet (ventes, stock, livraison, commissions), sans les réglages sensibles.",
    permissions: [
      "Commandes, Confirmation, Clients, Produits, Stock (voir/ajuster/transférer/inventorier), Emplacements, Livraison, Finance (lecture), Commissions, Analyses, Journal d'audit, Assistant IA.",
      "N'a pas : gestion financière avancée, Utilisateurs, Paramètres, Intégrations.",
    ],
  }),
  roleArticle({
    slug: "utilisateurs/role-confirmation",
    title: "CONFIRMATION",
    role: ["CONFIRMATION"],
    tagline: "Le rôle de l'équipe d'appel : commandes et confirmation, sans stock ni livraison ni finance.",
    permissions: ["Tableau de bord, Commandes (voir/créer/modifier/confirmer), Clients (voir/créer/modifier), Produits (voir), Assistant IA."],
    notes: "Documentation prioritaire pour ce rôle : Commandes, Confirmation, Problèmes fréquents.",
  }),
  roleArticle({
    slug: "utilisateurs/role-warehouse",
    title: "WAREHOUSE",
    role: ["WAREHOUSE"],
    tagline: "Le rôle magasinier : stock, entrepôts, transferts, inventaires.",
    permissions: ["Tableau de bord, Commandes (voir), Produits (voir), Stock (voir/ajuster/transférer/inventorier), Livraison (voir)."],
    notes: "Documentation prioritaire pour ce rôle : Stock, Entrepôts, Transferts, Inventaire.",
  }),
  roleArticle({
    slug: "utilisateurs/role-delivery",
    title: "DELIVERY",
    role: ["DELIVERY"],
    tagline: "Le rôle livraison : gestion complète des expéditions et transporteurs.",
    permissions: ["Tableau de bord, Commandes (voir), Livraison (voir/gérer)."],
    notes: "Documentation prioritaire pour ce rôle : Transporteurs, Villes, Expéditions, Suivi, Retours.",
  }),
  roleArticle({
    slug: "utilisateurs/role-support",
    title: "SUPPORT",
    role: ["SUPPORT"],
    tagline: "Le rôle support client : consultation des commandes, gestion des clients.",
    permissions: ["Tableau de bord, Commandes (voir), Clients (voir/modifier)."],
  }),
  roleArticle({
    slug: "utilisateurs/role-accountant",
    title: "ACCOUNTANT",
    role: ["ACCOUNTANT"],
    tagline: "Le rôle comptable : finance et commissions, sans les commandes opérationnelles ni le stock.",
    permissions: ["Tableau de bord, Commandes (voir), Finance (voir/gérer), Commissions (voir/gérer), Analyses, Journal d'audit."],
    notes: "Documentation prioritaire pour ce rôle : Finance, Rapports.",
  }),
  {
    slug: "utilisateurs/invitation",
    title: "Invitation et activation",
    category: "utilisateurs",
    tagline: "Inviter une personne par e-mail avec un rôle précis — le lien active son compte.",
    permission: "users.manage",
    prerequisites: [],
    steps: [
      "Ouvrir Utilisateurs → Inviter.",
      "Renseigner le nom, l'e-mail et le rôle.",
      "Envoyer — un e-mail avec un lien d'invitation valable 7 jours et à usage unique est envoyé.",
      "La personne ouvre le lien, choisit son mot de passe, et son compte est activé.",
    ],
    troubleshooting: [
      {
        symptom: "« Seul le propriétaire peut inviter un autre propriétaire. »",
        cause: "Un ADMIN essaie d'inviter quelqu'un avec le rôle OWNER.",
        check: "Vérifiez le rôle du compte qui envoie l'invitation.",
        solution: "Demandez à un compte OWNER d'envoyer cette invitation.",
        expectedResult: "—",
        errorStrings: ["Seul le propriétaire peut inviter un autre propriétaire."],
      },
      {
        symptom: "Le lien d'invitation ne fonctionne plus (« Cette invitation n'est plus valide. »)",
        cause: "Le lien a plus de 7 jours, a déjà été utilisé, ou a été révoqué (une nouvelle invitation à la même adresse révoque automatiquement l'ancienne).",
        check: "Vérifiez la date d'envoi.",
        solution: "Renvoyez une nouvelle invitation depuis Utilisateurs.",
        expectedResult: "Un nouveau lien, valable 7 jours, est reçu.",
        errorStrings: ["Cette invitation n'est plus valide.", "Il a peut-être expiré, déjà été utilisé, ou été révoqué."],
      },
    ],
    related: ["bien-demarrer/premiere-connexion", "utilisateurs/mot-de-passe"],
    tryNow: { label: "Ouvrir Utilisateurs", href: "/utilisateurs" },
    lastUpdated: LAST_UPDATED,
    keywords: ["invitation expirée"],
  },
  {
    slug: "utilisateurs/mot-de-passe",
    title: "Mot de passe oublié et réinitialisation",
    category: "utilisateurs",
    tagline: "Deux façons de réinitialiser un mot de passe : la demande par l'utilisateur lui-même, ou l'action d'un administrateur.",
    steps: [
      "Demande personnelle : depuis l'écran de connexion, « Mot de passe oublié » → renseigner son e-mail → un lien de réinitialisation valable 1 heure et à usage unique est envoyé s'il correspond à un compte.",
      "Action d'un administrateur (permission Utilisateurs) : depuis la fiche d'un utilisateur, générer un lien de réinitialisation et le transmettre directement à la personne (il n'est pas envoyé par e-mail dans ce cas).",
    ],
    body: [
      {
        type: "callout",
        tone: "info",
        text: "Pour des raisons de sécurité, la demande personnelle ne révèle jamais si l'e-mail saisi correspond réellement à un compte existant.",
      },
    ],
    troubleshooting: [
      {
        symptom: "« Ce lien de réinitialisation n'est plus valide. »",
        cause: "Le lien a plus d'une heure, ou a déjà été utilisé.",
        check: "Vérifiez depuis quand le lien a été généré.",
        solution: "Redemandez un nouveau lien depuis la page de connexion, ou demandez à un administrateur d'en générer un nouveau.",
        expectedResult: "Un nouveau lien, valable 1 heure, permet de choisir un nouveau mot de passe.",
        errorStrings: ["Ce lien de réinitialisation n'est plus valide.", "Il a peut-être expiré ou déjà été utilisé."],
      },
      {
        symptom: "« Impossible de réinitialiser le mot de passe du propriétaire. »",
        cause: "Un administrateur essaie de réinitialiser le mot de passe d'un compte OWNER.",
        check: "—",
        solution: "Seul le propriétaire peut réinitialiser son propre mot de passe, via la demande personnelle.",
        expectedResult: "—",
        errorStrings: ["Impossible de réinitialiser le mot de passe du propriétaire."],
      },
    ],
    related: ["utilisateurs/invitation", "utilisateurs/acces-refuse"],
    tryNow: { label: "Se connecter", href: "/connexion" },
    lastUpdated: LAST_UPDATED,
    keywords: ["mot de passe oublié", "reset password"],
  },
  {
    slug: "utilisateurs/acces-refuse",
    title: "Accès refusé",
    category: "utilisateurs",
    tagline: "Un message clair s'affiche quand votre rôle ne permet pas d'ouvrir une page ou d'effectuer une action.",
    troubleshooting: [
      {
        symptom: "Page « Accès refusé »",
        cause: "Votre rôle ne dispose pas de la permission nécessaire pour cette page.",
        check: "Consultez « Comprendre les rôles et permissions » pour voir ce que votre rôle peut faire.",
        solution: "Demandez à un OWNER/ADMIN de vous accorder un rôle adapté, ou de réaliser l'action à votre place.",
        expectedResult: "—",
        errorStrings: ["Votre rôle ne dispose pas des permissions nécessaires pour accéder à cette page.", "Non autorisé : permission manquante pour cette action."],
      },
    ],
    related: ["utilisateurs/comprendre-les-roles"],
    lastUpdated: LAST_UPDATED,
    keywords: ["accès refusé", "permission manquante", "non autorisé"],
  },
  {
    slug: "utilisateurs/tenant-isolation",
    title: "Isolation entre entreprises (tenant isolation)",
    category: "utilisateurs",
    tagline: "Vos données n'appartiennent qu'à votre entreprise — aucun autre client ASODITECH ne peut jamais y accéder.",
    body: [
      {
        type: "p",
        text: "Chaque commande, produit, client, mouvement de stock ou donnée financière est rattaché à votre entreprise et protégé à deux niveaux techniques indépendants. Concrètement : vous ne verrez jamais, même par accident (lien copié, identifiant deviné), la moindre donnée d'une autre entreprise cliente d'ASODITECH — et personne d'autre ne verra les vôtres.",
      },
    ],
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "utilisateurs/journal-audit",
    title: "Journal d'audit",
    category: "utilisateurs",
    tagline: "L'historique complet et non modifiable de toutes les actions importantes de votre entreprise.",
    permission: "audit.view",
    steps: ["Ouvrir Journal d'audit.", "Filtrer par catégorie ou rechercher un mot-clé.", "Cliquer sur une entrée pour ouvrir l'élément concerné (commande, produit…) quand c'est possible."],
    body: [{ type: "p", text: "À la différence des Notifications (personnelles, temporaires), le Journal d'audit couvre toute l'entreprise et n'est jamais supprimé." }],
    related: ["bien-demarrer/comprendre-les-notifications"],
    tryNow: { label: "Ouvrir le Journal d'audit", href: "/journal-audit" },
    lastUpdated: LAST_UPDATED,
  },
];
