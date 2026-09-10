import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-10";

export const confirmationArticles: DocArticle[] = [
  {
    slug: "confirmation/role-confirmation",
    title: "Rôle CONFIRMATION",
    category: "confirmation",
    tagline: "Le rôle dédié à l'appel téléphonique de confirmation, très courant en vente à la livraison au Maroc.",
    roles: ["CONFIRMATION"],
    permission: "orders.confirm",
    body: [
      {
        type: "p",
        text: "Un agent CONFIRMATION voit et peut créer des commandes, gérer les clients, et surtout travailler la file d'attente Confirmation. Il n'a pas accès au stock, à la livraison ni à la finance.",
      },
      {
        type: "p",
        text: "Chaque commande qu'il confirme lui est automatiquement attribuée comme agent de confirmation — c'est ce qui déterminera plus tard sa commission une fois la commande livrée (voir Commissions).",
      },
    ],
    related: ["confirmation/workflow-de-confirmation", "utilisateurs/role-confirmation"],
    tryNow: { label: "Ouvrir la file de confirmation", href: "/confirmation" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "confirmation/workflow-de-confirmation",
    title: "Workflow de confirmation",
    category: "confirmation",
    tagline: "Appeler le client, enregistrer le résultat de l'appel, et confirmer ou annuler la commande.",
    roles: ["CONFIRMATION", "MANAGER"],
    permission: "orders.confirm",
    prerequisites: [],
    steps: [
      "Ouvrir Confirmation — la file affiche toutes les commandes Nouvelle, jamais appelées d'abord, puis les moins récemment rappelées.",
      "Appeler le client (lien cliquable vers le numéro).",
      "Si le client confirme : cliquer sur Confirmer — la commande passe au statut Confirmée, le stock est réservé, et vous devenez son agent de confirmation si elle n'en avait pas déjà un.",
      "Si le client ne répond pas / rappelle plus tard / occupé / faux numéro : choisir le résultat correspondant et Enregistrer — la commande reste dans la file.",
      "Si le client ne veut plus la commande : Annuler la commande.",
    ],
    whatYouShouldSee:
      "Chaque tentative (la vôtre et celles des autres agents) reste visible dans l'historique de la commande, même si ce n'est pas vous qui l'avez finalement confirmée.",
    body: [
      {
        type: "callout",
        tone: "warning",
        title: "Confirmer ≠ commission acquise",
        text: "Confirmer une commande ne verse aucune commission. La commission n'est acquise qu'une fois la commande réellement Livrée — voir Statuts.",
      },
    ],
    commonMistakes: [
      "Confondre « qui a appelé » et « qui est l'agent de confirmation » : si un premier agent appelle sans succès et qu'un second confirme ensuite, c'est le second qui devient l'agent de confirmation — le premier appel reste dans l'historique mais ne donne droit à rien.",
    ],
    related: ["confirmation/statuts", "confirmation/que-faire-si-non-confirmable", "confirmation/causes-frequentes"],
    tryNow: { label: "Ouvrir la file de confirmation", href: "/confirmation" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "confirmation/statuts",
    title: "Statuts",
    category: "confirmation",
    tagline: "Les résultats possibles d'une tentative d'appel, et ce que chacun déclenche.",
    permission: "orders.confirm",
    body: [
      {
        type: "table",
        headers: ["Résultat de l'appel", "Effet"],
        rows: [
          ["Confirmée", "La commande passe à Confirmée, le stock est réservé."],
          ["Pas de réponse", "La tentative est enregistrée, la commande reste dans la file."],
          ["Occupé", "Idem."],
          ["Rappeler", "Idem — apparaît dans l'onglet « À rappeler »."],
          ["Faux numéro", "Idem — signalement utile pour la suite."],
          ["Annulée", "La commande passe à Annulée, aucun mouvement de stock (elle n'en avait pas encore réservé)."],
        ],
      },
      {
        type: "p",
        text: "Une commande avec 3 tentatives ou plus est signalée dans la file (badge distinct) pour attirer l'attention.",
      },
    ],
    related: ["confirmation/workflow-de-confirmation", "commandes/comprendre-les-statuts"],
    tryNow: { label: "Ouvrir la file de confirmation", href: "/confirmation" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "confirmation/que-faire-si-non-confirmable",
    title: "Que faire lorsqu'une commande ne peut pas être confirmée",
    category: "confirmation",
    tagline: "Enregistrer le bon résultat plutôt que de laisser la commande sans suivi.",
    permission: "orders.confirm",
    steps: [
      "Si le client ne répond jamais après plusieurs tentatives : enregistrer chaque tentative avec le résultat exact (Pas de réponse, Occupé…) pour garder un historique complet.",
      "Si le numéro est manifestement faux : enregistrer « Faux numéro » plutôt que de laisser la commande sans suivi, puis alerter un manager si le client ne peut être recontacté par un autre canal.",
      "Si le client refuse la commande : Annuler la commande directement depuis la file.",
    ],
    whatYouShouldSee: "L'historique de confirmation de la commande liste toutes les tentatives dans l'ordre, avec l'agent et l'heure de chacune.",
    related: ["confirmation/causes-frequentes", "confirmation/statuts"],
    tryNow: { label: "Ouvrir la file de confirmation", href: "/confirmation" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "confirmation/commissions-des-agents",
    title: "Commissions des agents de confirmation",
    category: "confirmation",
    tagline: "Un montant fixe par commande, versé à l'agent qui l'a confirmée — mais acquis uniquement une fois la commande livrée.",
    permission: "commissions.view",
    prerequisites: [],
    steps: [
      "Un manager crée un agent de confirmation (Commissions → Ajouter un agent) avec un taux par commande.",
      "Chaque commande confirmée par cet agent lui est automatiquement attribuée.",
      "Une fois la commande Livrée, la commission est acquise automatiquement — rien à faire manuellement.",
      "Si la commande est ensuite retournée, la commission déjà acquise est automatiquement reprise (annulée).",
      "En fin de mois, un manager clôture la période — un relevé figé est créé, puis marqué payé une fois le versement effectué.",
    ],
    body: [
      {
        type: "callout",
        tone: "warning",
        title: "Confirmer ≠ commission acquise",
        text: "Confirmer une commande ne verse jamais de commission immédiatement — seule la livraison déclenche le versement. Voir /confirmation/performance pour une vue par agent (confirmées, livrées, taux de conversion, commissions acquises et reversées).",
      },
      { type: "p", text: "Un taux modifié ne change jamais une commission déjà acquise dans le passé — chaque commission garde le taux en vigueur au moment où elle a été acquise." },
    ],
    related: ["confirmation/workflow-de-confirmation", "finance/rentabilite"],
    tryNow: { label: "Ouvrir Commissions", href: "/commissions" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "confirmation/causes-frequentes",
    title: "Causes fréquentes",
    category: "confirmation",
    tagline: "Pourquoi une commande reste bloquée dans la file de confirmation.",
    permission: "orders.confirm",
    troubleshooting: [
      {
        symptom: "Une commande n'apparaît plus dans la file « À confirmer »",
        cause: "Elle a déjà été confirmée ou annulée par quelqu'un d'autre — la file ne montre que les commandes encore au statut Nouvelle.",
        check: "Recherchez la commande directement dans Commandes.",
        solution: "Consultez son historique de confirmation pour voir qui l'a traitée et quand.",
        expectedResult: "—",
      },
      {
        symptom: "Impossible d'agir sur une commande depuis la file",
        cause: "La commande a changé de statut entre l'affichage de la page et le clic (quelqu'un d'autre vient de la traiter).",
        check: "Rechargez la page.",
        solution: "La commande n'apparaîtra plus dans la file si elle a déjà été traitée.",
        expectedResult: "—",
      },
    ],
    related: ["confirmation/workflow-de-confirmation"],
    tryNow: { label: "Ouvrir la file de confirmation", href: "/confirmation" },
    lastUpdated: LAST_UPDATED,
  },
];
