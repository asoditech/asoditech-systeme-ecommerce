import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-10";

/**
 * Category N — the dedicated error/troubleshooting knowledge base. Each
 * entry mirrors the spec's literal example symptom list. Every one is
 * self-contained (own Symptôme→Cause→Vérification→Solution→Résultat) and
 * `related` to the deeper feature article that has the full context —
 * never the other way only, so the KB is browsable on its own.
 *
 * Two entries ("Aucun entrepôt par défaut", "Produit affiché à 0") have no
 * verbatim thrown error string in the codebase — see the note inside each.
 * Nothing here is invented: every symptom is grounded in a real, verified
 * mechanism, and no fabricated error text is presented as verbatim.
 */
export const troubleshootingArticles: DocArticle[] = [
  {
    slug: "troubleshooting/impossible-de-creer-une-livraison",
    title: "Impossible de créer une livraison",
    category: "troubleshooting",
    tagline: "La commande n'est pas dans le bon statut, ou son adresse est incomplète.",
    troubleshooting: [
      {
        symptom: "Impossible de créer une livraison",
        cause: "La commande n'est pas Confirmée/En préparation/Échec, ou son adresse de livraison (adresse + ville) est incomplète.",
        check: "Ouvrez la commande et vérifiez son statut et son adresse.",
        solution: "Confirmez la commande si nécessaire, complétez l'adresse, puis recréez l'expédition.",
        expectedResult: "L'expédition est créée.",
        errorStrings: [
          "Cette commande n'est pas dans un statut permettant de créer une expédition.",
          "L'adresse de livraison de la commande est incomplète — l'adresse et la ville sont requises.",
        ],
      },
    ],
    related: ["livraison/creer-une-expedition"],
    tryNow: { label: "Ouvrir Livraison", href: "/livraison" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/ville-non-reconnue",
    title: "Ville non reconnue",
    category: "troubleshooting",
    tagline: "Le transporteur choisi ne reconnaît pas la ville de la commande.",
    troubleshooting: [
      {
        symptom: "Ville non reconnue par le transporteur",
        cause: "Aucune correspondance de ville n'existe, et la normalisation automatique ne trouve pas de correspondance sûre (ou en trouve plusieurs à la fois).",
        check: "Livraison → Prestataires → Correspondances de villes, pour le transporteur concerné.",
        solution: "Ajoutez une correspondance de ville précise entre la ville de la commande et la ville exacte du référentiel transporteur.",
        expectedResult: "La création d'expédition réussit pour cette ville.",
        errorStrings: ["ne correspond à aucune ville desservie par OzonExpress", "correspond à plusieurs villes OzonExpress à la fois"],
      },
    ],
    related: ["livraison/villes-et-correspondances"],
    tryNow: { label: "Ouvrir Livraison", href: "/livraison" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/aucun-entrepot-par-defaut",
    title: "Aucun entrepôt par défaut",
    category: "troubleshooting",
    tagline: "Un état qui ne devrait normalement jamais se produire — l'entrepôt par défaut est protégé contre la désactivation.",
    body: [
      {
        type: "callout",
        tone: "info",
        text: "Il n'existe pas de message d'erreur « Aucun entrepôt par défaut » dans ASODITECH aujourd'hui, car cette situation est empêchée par conception : un entrepôt marqué par défaut est créé automatiquement à la création de votre compte et ne peut jamais être désactivé depuis l'interface.",
      },
    ],
    troubleshooting: [
      {
        symptom: "« Entrepôt de préparation invalide » lors de la création d'une commande, alors qu'aucun entrepôt n'a été choisi",
        cause: "L'entrepôt explicitement sélectionné pour la commande n'existe pas ou n'est pas actif — ce n'est pas la même chose qu'une absence d'entrepôt par défaut.",
        check: "Vérifiez la liste des entrepôts actifs dans Emplacements.",
        solution: "Laissez le champ entrepôt vide (l'entrepôt par défaut sera utilisé) ou choisissez un entrepôt actif.",
        expectedResult: "La commande est créée.",
        errorStrings: ["Entrepôt de préparation invalide."],
      },
    ],
    related: ["stock/entrepot-par-defaut"],
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/produit-affiche-a-0",
    title: "Produit affiché à 0",
    category: "troubleshooting",
    tagline: "Un stock ou un prix à 0 est presque toujours un état réel — pas un bug — une fois qu'on connaît le mécanisme exact.",
    body: [
      {
        type: "callout",
        tone: "info",
        text: "Il n'existe pas de message d'erreur « produit à 0 » dans le code — ce symptôme regroupe en réalité deux mécanismes bien réels et volontaires, expliqués ci-dessous.",
      },
    ],
    troubleshooting: [
      {
        symptom: "Le stock disponible affiché est 0",
        cause: "Le stock disponible se calcule comme (quantité en stock − quantité réservée), plafonné à 0 — c'est un vrai 0, pas une erreur d'affichage, dès que tout le stock physique est réservé ou vendu.",
        check: "Consultez la quantité en stock ET la quantité réservée séparément dans Stock.",
        solution: "Réceptionnez du stock supplémentaire, ou attendez qu'une réservation soit libérée (commande annulée) ou consommée (expédition).",
        expectedResult: "Le stock disponible remonte au-dessus de 0.",
      },
      {
        symptom: "Le prix ou le stock d'une variation affiche 0",
        cause: "Un produit variable résout prix/coût/stock au niveau de la variation exacte sélectionnée — si cette variation précise n'a pas encore de valeur propre, ou si sa synchronisation avec WooCommerce/Shopify est en décalage, elle peut afficher 0 même si le produit parent a bien un prix ou un stock.",
        check: "Vérifiez la variation exacte (pas seulement le produit parent) dans Produits.",
        solution: "Renseignez le prix/coût sur la variation, ou relancez une synchronisation depuis Intégrations si la boutique d'origine affiche une valeur différente.",
        expectedResult: "La variation affiche la bonne valeur.",
      },
    ],
    related: ["stock/stock-disponible", "produits/produits-variables"],
    lastUpdated: LAST_UPDATED,
    keywords: ["pourquoi mon produit est à 0", "produit à 0", "prix à 0", "stock à 0"],
  },
  {
    slug: "troubleshooting/commande-introuvable",
    title: "Commande introuvable",
    category: "troubleshooting",
    tagline: "L'identifiant de commande visé n'existe pas dans votre entreprise.",
    troubleshooting: [
      {
        symptom: "« Commande introuvable. »",
        cause: "Un lien copié pointe vers un identifiant de commande qui n'existe pas (ou plus) dans votre compte.",
        check: "Revenez à la liste Commandes.",
        solution: "Recherchez la commande directement dans Commandes plutôt que via un lien externe.",
        expectedResult: "La commande s'ouvre normalement si elle existe.",
        errorStrings: ["Commande introuvable."],
      },
    ],
    related: ["commandes/problemes-frequents"],
    tryNow: { label: "Ouvrir Commandes", href: "/commandes" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/authentification-woocommerce-refusee",
    title: "Authentification WooCommerce refusée",
    category: "troubleshooting",
    tagline: "La clé ou le secret API WooCommerce sont incorrects, révoqués, ou sans les bonnes permissions.",
    troubleshooting: [
      {
        symptom: "Authentification WooCommerce refusée",
        cause: "Clé/secret API incorrects ou révoqués, ou permissions insuffisantes sur la clé.",
        check: "WooCommerce → Réglages → Avancé → API REST.",
        solution: "Régénérez une clé avec les permissions Lecture/Écriture, puis reconnectez.",
        expectedResult: "Le test de connexion réussit.",
        errorStrings: [
          "Authentification refusée par la boutique WooCommerce — vérifiez la clé et le secret API.",
          "Clé ou secret API refusés par la boutique WooCommerce. Régénérez une clé avec les permissions Lecture/Écriture dans WooCommerce → Réglages → Avancé → API REST, puis reconnectez.",
        ],
      },
    ],
    related: ["integrations/problemes-authentification"],
    tryNow: { label: "Ouvrir Intégrations", href: "/integrations" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/boutique-na-pas-transmis-authorization",
    title: "La boutique n'a pas transmis Authorization",
    category: "troubleshooting",
    tagline: "Le serveur web de la boutique bloque l'en-tête d'authentification avant qu'il n'atteigne WooCommerce.",
    troubleshooting: [
      {
        symptom: "La boutique WooCommerce n'a pas reçu les identifiants API malgré des identifiants corrects",
        cause: "Le serveur web (fréquent avec LiteSpeed / Hostinger) supprime l'en-tête HTTP Authorization avant qu'il n'arrive à WooCommerce.",
        check: "Identifiez l'hébergeur/serveur web de la boutique.",
        solution: "Ajoutez la règle de réécriture qui transmet l'en-tête Authorization dans le fichier .htaccess de la boutique.",
        expectedResult: "L'en-tête est transmis, le test de connexion réussit.",
        errorStrings: [
          "La boutique WooCommerce n'a pas reçu les identifiants API — le serveur web ne transmet pas l'en-tête « Authorization » à WooCommerce (fréquent avec LiteSpeed / Hostinger). Ajoutez la règle de réécriture correspondante dans le .htaccess de la boutique, puis réessayez.",
        ],
      },
    ],
    related: ["integrations/problemes-authentification"],
    tryNow: { label: "Ouvrir Intégrations", href: "/integrations" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/cout-manquant",
    title: "Coût manquant",
    category: "troubleshooting",
    tagline: "Le coût d'achat n'était pas renseigné au moment de cette vente précise.",
    troubleshooting: [
      {
        symptom: "« Coût manquant » sur une commande, un produit ou un rapport",
        cause: "Le produit/la variation n'avait pas de coût d'achat renseigné au moment de la vente.",
        check: "Ouvrez la fiche produit.",
        solution: "Renseignez le coût, puis utilisez « Appliquer le coût rétroactivement ».",
        expectedResult: "La rentabilité devient calculable.",
        errorStrings: ["Coût manquant", "coût manquant"],
      },
    ],
    related: ["finance/pourquoi-cout-manquant", "produits/snapshots-des-couts"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/acces-refuse",
    title: "Accès refusé",
    category: "troubleshooting",
    tagline: "Votre rôle ne dispose pas de la permission nécessaire pour cette page ou cette action.",
    troubleshooting: [
      {
        symptom: "Page ou action « Accès refusé »",
        cause: "Permission manquante pour votre rôle actuel.",
        check: "Consultez « Comprendre les rôles et permissions ».",
        solution: "Demandez à un OWNER/ADMIN de vous accorder un rôle adapté ou d'effectuer l'action.",
        expectedResult: "—",
        errorStrings: ["Votre rôle ne dispose pas des permissions nécessaires pour accéder à cette page.", "Non autorisé : permission manquante pour cette action."],
      },
    ],
    related: ["utilisateurs/acces-refuse", "utilisateurs/comprendre-les-roles"],
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/invitation-expiree",
    title: "Invitation expirée",
    category: "troubleshooting",
    tagline: "Le lien d'invitation a plus de 7 jours, a déjà été utilisé, ou a été révoqué.",
    troubleshooting: [
      {
        symptom: "« Cette invitation n'est plus valide. »",
        cause: "Lien de plus de 7 jours, déjà utilisé, ou révoqué par une invitation plus récente.",
        check: "Vérifiez la date d'envoi de l'e-mail.",
        solution: "Demandez à un administrateur de renvoyer une nouvelle invitation.",
        expectedResult: "Un nouveau lien, valable 7 jours, est reçu.",
        errorStrings: ["Cette invitation n'est plus valide."],
      },
    ],
    related: ["utilisateurs/invitation"],
    tryNow: { label: "Ouvrir Utilisateurs", href: "/utilisateurs" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/mot-de-passe-oublie",
    title: "Mot de passe oublié",
    category: "troubleshooting",
    tagline: "Demandez un lien de réinitialisation à usage unique, valable 1 heure.",
    troubleshooting: [
      {
        symptom: "Impossible de se connecter, mot de passe oublié",
        cause: "—",
        check: "—",
        solution: "Depuis l'écran de connexion, utilisez « Mot de passe oublié » et suivez le lien reçu par e-mail (valable 1 heure).",
        expectedResult: "Un nouveau mot de passe peut être choisi.",
      },
    ],
    related: ["utilisateurs/mot-de-passe"],
    tryNow: { label: "Se connecter", href: "/connexion" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/google-drive-deconnecte",
    title: "Google Drive déconnecté",
    category: "troubleshooting",
    tagline: "La sauvegarde locale continue de fonctionner ; seul l'envoi vers Drive doit être reconnecté.",
    troubleshooting: [
      {
        symptom: "« La connexion Google Drive a expiré ou a été révoquée. »",
        cause: "Autorisation Google expirée ou révoquée.",
        check: "—",
        solution: "Cliquez sur « Reconnecter » dans Paramètres → Sauvegarde & Portabilité.",
        expectedResult: "L'envoi de sauvegardes vers Drive reprend.",
        errorStrings: ["La connexion Google Drive a expiré ou a été révoquée. Reconnectez-vous pour reprendre les envois."],
      },
    ],
    related: ["sauvegarde/google-drive-deconnecte"],
    tryNow: { label: "Ouvrir Sauvegarde", href: "/parametres/sauvegarde" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "troubleshooting/synchronisation-echouee",
    title: "Synchronisation échouée",
    category: "troubleshooting",
    tagline: "La boutique a renvoyé une erreur pendant l'import — la synchronisation suivante reprend exactement où elle s'est arrêtée.",
    troubleshooting: [
      {
        symptom: "Synchronisation échouée",
        cause: "Erreur renvoyée par la boutique (indisponibilité temporaire, limitation de requêtes, URL incorrecte…).",
        check: "Lisez le message d'erreur exact affiché sur la carte de connexion.",
        solution: "Réessayez plus tard pour une indisponibilité temporaire ; vérifiez l'URL pour une boutique introuvable.",
        expectedResult: "La synchronisation reprend et se termine sans perte de commande.",
        errorStrings: [
          "La boutique WooCommerce a limité le nombre de requêtes. Réessayez plus tard.",
          "La boutique WooCommerce est momentanément indisponible.",
          "Shopify a limité le nombre de requêtes. Réessayez dans un instant.",
        ],
      },
    ],
    related: ["integrations/problemes-synchronisation"],
    tryNow: { label: "Ouvrir Intégrations", href: "/integrations" },
    lastUpdated: LAST_UPDATED,
  },
];
