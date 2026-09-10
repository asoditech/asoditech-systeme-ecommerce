import type { GuidedTour } from "./types";

/**
 * §3 interactive demos. Each step is descriptive only — "Essayer
 * maintenant" links navigate to the real page, never automate or mutate
 * anything from the documentation itself.
 */
export const GUIDED_TOURS: GuidedTour[] = [
  {
    slug: "creer-votre-premiere-commande",
    title: "Créer votre première commande",
    tagline: "De la création à la livraison suivie, en passant par la confirmation.",
    steps: [
      { label: "Ouvrir Commandes", description: "C'est ici que vivent toutes vos commandes.", href: "/commandes" },
      { label: "Créer une commande", description: "Choisissez « Nouvelle commande ».", href: "/commandes/nouvelle" },
      { label: "Choisir le client", description: "Sélectionnez un client existant ou créez-en un." },
      { label: "Ajouter le produit", description: "Ajoutez un ou plusieurs articles, avec leur quantité." },
      { label: "Vérifier le prix", description: "Le prix, le nom et le coût sont recalculés côté serveur — vérifiez le total." },
      { label: "Confirmer", description: "Appelez le client depuis la file Confirmation, puis validez.", href: "/confirmation" },
      { label: "Créer la livraison", description: "Depuis la commande confirmée, créez l'expédition chez un transporteur.", href: "/livraison" },
      { label: "Suivre l'expédition", description: "Suivez son avancement jusqu'à la livraison.", href: "/livraison/suivi" },
    ],
  },
  {
    slug: "connecter-woocommerce",
    title: "Connecter votre boutique WooCommerce",
    tagline: "De la clé API au premier produit synchronisé.",
    roles: ["OWNER", "ADMIN"],
    steps: [
      { label: "Ouvrir Intégrations", description: "C'est ici que toutes vos connexions se gèrent.", href: "/integrations" },
      { label: "Connecter WooCommerce", description: "Renseignez l'URL de la boutique, la clé et le secret API." },
      { label: "Tester la connexion", description: "Vérifiez que les identifiants sont valides avant toute synchronisation." },
      { label: "Synchroniser les produits", description: "Importez votre catalogue existant." },
      { label: "Vérifier Produits", description: "Confirmez que vos produits sont bien arrivés.", href: "/produits" },
    ],
  },
  {
    slug: "traiter-un-transfert-de-stock",
    title: "Traiter un transfert de stock",
    tagline: "Déplacer du stock d'un entrepôt à un autre en toute sécurité.",
    roles: ["WAREHOUSE", "MANAGER"],
    steps: [
      { label: "Ouvrir Transferts", description: "La liste de tous vos transferts.", href: "/transferts" },
      { label: "Créer un transfert", description: "Choisissez l'entrepôt source, la destination, et les articles." },
      { label: "Expédier", description: "Le stock est immédiatement déduit de l'entrepôt source." },
      { label: "Recevoir", description: "À l'arrivée physique, saisissez la quantité réellement reçue." },
    ],
  },
  {
    slug: "cloturer-un-inventaire",
    title: "Clôturer un inventaire",
    tagline: "Du comptage physique à la correction automatique du stock.",
    roles: ["WAREHOUSE", "MANAGER"],
    steps: [
      { label: "Ouvrir Inventaires", description: "La liste de vos sessions d'inventaire.", href: "/inventaires" },
      { label: "Démarrer un inventaire", description: "Choisissez l'entrepôt — une ligne est créée pour chaque article qu'il détient." },
      { label: "Saisir les comptages", description: "Renseignez la quantité comptée pour chaque article, au fil du comptage physique." },
      { label: "Clôturer", description: "Chaque écart devient un mouvement de stock ; les lignes non comptées sont ignorées." },
    ],
  },
  {
    slug: "configurer-une-sauvegarde",
    title: "Configurer une sauvegarde",
    tagline: "Sécuriser vos données localement, et optionnellement vers Google Drive.",
    roles: ["OWNER", "ADMIN"],
    steps: [
      { label: "Ouvrir Sauvegarde & Portabilité", description: "Le module dédié dans Paramètres.", href: "/parametres/sauvegarde" },
      { label: "Sauvegarder maintenant", description: "Générez et téléchargez une première sauvegarde chiffrée." },
      { label: "Connecter Google Drive (optionnel)", description: "Pour un envoi automatique en plus du téléchargement local." },
      { label: "Vérifier une restauration", description: "Importez le fichier pour voir l'aperçu — sans jamais valider la restauration si ce n'est qu'un test." },
    ],
  },
];

export function getGuidedTour(slug: string): GuidedTour | undefined {
  return GUIDED_TOURS.find((t) => t.slug === slug);
}
