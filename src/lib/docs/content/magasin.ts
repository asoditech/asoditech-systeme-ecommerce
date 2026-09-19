import type { DocArticle } from "../types";

const LAST_UPDATED = "2026-09-19";

/**
 * Magasin & achats — docs/adr/0038 (canaux, identité catalogue), 0039
 * (accès), 0040 (ventes magasin, réceptions, fournisseurs, traçabilité).
 * Every message quoted in `errorStrings` is taken verbatim from the code.
 */
export const magasinArticles: DocArticle[] = [
  {
    slug: "magasin/ventes-magasin",
    title: "Vendre en magasin",
    category: "magasin",
    tagline: "Enregistrez une vente au comptoir : elle décrémente immédiatement le stock physique de l'emplacement de vente.",
    permission: "sales.create",
    roles: ["OWNER", "ADMIN", "MANAGER"],
    prerequisites: [
      "Un canal de vente de type Magasin, rattaché à un emplacement (Paramètres → Canaux de vente).",
      "Vous devez être assigné à ce canal et à cet emplacement (Utilisateurs).",
      "Les produits doivent être vendables sur ce canal et avoir du stock à cet emplacement.",
    ],
    steps: [
      "Ouvrir Ventes magasin → Nouvelle vente.",
      "Choisir le canal et l'emplacement.",
      "Scanner un code-barres (ou saisir une référence / un nom) et valider avec Entrée.",
      "Ajuster les quantités ; saisir le paiement (l'ensemble des paiements doit égaler le total).",
      "Valider la vente.",
    ],
    whatYouShouldSee: "La vente reçoit un numéro VTE-…, le stock de l'emplacement diminue, et un mouvement « Vente » horodaté apparaît dans la Traçabilité.",
    body: [
      { type: "p", text: "Une vente magasin est un type de transaction distinct de la commande livrée : pas de confirmation, pas d'expédition, pas de transporteur. Elle ne peut consommer que le stock disponible (physique moins réservé) : les unités réservées pour une commande en ligne confirmée ne peuvent jamais être vendues en magasin." },
      { type: "callout", tone: "info", title: "Une seule validation, un seul décrément", text: "Chaque vente porte une clé unique : un double clic ou une nouvelle tentative ne crée qu'une seule vente et ne décrémente le stock qu'une fois. Si un article manque, toute la vente est refusée — rien n'est enregistré à moitié." },
      { type: "p", text: "Le prix vient du catalogue. Modifier un prix ou appliquer une remise nécessite la permission « Modifier le prix » (sales.override_price)." },
    ],
    troubleshooting: [
      {
        symptom: "« Stock disponible insuffisant … »",
        cause: "La quantité demandée dépasse le disponible : le reste est réservé pour des commandes en ligne confirmées.",
        check: "Ouvrir Traçabilité et regarder Physique / Réservé / Disponible à cet emplacement.",
        solution: "Réduire la quantité, ou attendre l'expédition/annulation des commandes concernées.",
        expectedResult: "La vente est acceptée pour la quantité disponible.",
        errorStrings: ["Stock disponible insuffisant"],
      },
      {
        symptom: "« … n'est pas suivi en stock à cet emplacement — vente impossible. »",
        cause: "Cet article n'a pas de ligne de stock à l'emplacement de vente (aucune réception ni transfert ne l'y a amené).",
        check: "Traçabilité → chercher l'article → « Où est le stock maintenant ».",
        solution: "Recevoir l'article à cet emplacement (Réceptions) ou le transférer depuis un autre emplacement.",
        expectedResult: "L'article devient vendable.",
        errorStrings: ["n'est pas suivi en stock à cet emplacement"],
      },
      {
        symptom: "« La somme des paiements … doit être égale au total … »",
        cause: "Les paiements saisis ne couvrent pas exactement le total.",
        check: "Comparer le total et la somme des lignes de paiement.",
        solution: "Ajuster les montants (« Tout en espèces » remplit le total).",
        expectedResult: "La vente est enregistrée.",
        errorStrings: ["doit être égale au total"],
      },
    ],
    related: ["magasin/tracabilite", "magasin/canaux-et-acces"],
    tryNow: { label: "Ouvrir Ventes magasin", href: "/ventes" },
    keywords: ["pos", "caisse", "point de vente", "code-barres", "scanner", "offline", "comptoir"],
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "magasin/receptions",
    title: "Réceptions de marchandise",
    category: "magasin",
    tagline: "Une réception enregistre la marchandise reçue d'un fournisseur ; sa validation ajoute le stock, une seule fois.",
    permission: "purchases.create",
    steps: [
      "Ouvrir Réceptions → Nouvelle réception.",
      "Choisir le fournisseur et l'emplacement de destination.",
      "Scanner ou rechercher chaque article, saisir quantité et prix d'achat.",
      "Enregistrer le brouillon, puis « Valider et ajouter au stock ».",
    ],
    body: [
      { type: "p", text: "Un brouillon n'ajoute aucun stock. La validation écrit un mouvement « Réception » par ligne (avec le prix d'achat et le lien vers la réception) : c'est ce mouvement qui fait foi pour le stock. Valider deux fois n'ajoute jamais le stock deux fois." },
      { type: "callout", tone: "warning", title: "Une réception validée est définitive", text: "Elle ne peut être ni modifiée ni supprimée : le stock qu'elle a ajouté reste tracé. Seul un brouillon peut être modifié ou annulé." },
      { type: "p", text: "Recevoir et payer sont deux événements séparés : le paiement d'un fournisseur (permission « Payer les fournisseurs ») n'ajoute aucun stock." },
    ],
    troubleshooting: [
      {
        symptom: "« Une réception validée ou annulée ne peut plus être modifiée. »",
        cause: "Seul un brouillon est modifiable.",
        check: "Le statut de la réception.",
        solution: "Pour corriger un stock reçu par erreur, utiliser un ajustement ou un inventaire (traçés dans le journal).",
        expectedResult: "—",
        errorStrings: ["Une réception validée ou annulée ne peut plus être modifiée."],
      },
    ],
    related: ["magasin/fournisseurs", "magasin/tracabilite"],
    tryNow: { label: "Ouvrir Réceptions", href: "/receptions" },
    keywords: ["achat", "bon de réception", "prix d'achat", "entrée de stock"],
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "magasin/fournisseurs",
    title: "Fournisseurs et soldes",
    category: "magasin",
    tagline: "Vos fournisseurs, ce qui leur a été payé et ce qu'il reste à payer — calculé, jamais saisi.",
    permission: "suppliers.view",
    body: [
      { type: "p", text: "Le solde dû d'un fournisseur est dérivé : total des réceptions validées moins total des paiements. Un brouillon ou une réception annulée ne génère aucune dette." },
      { type: "p", text: "Un paiement peut régler une réception validée précise (il ne peut pas dépasser son reste à payer) ou être posé sur le compte du fournisseur. Il ne crée jamais de mouvement de stock." },
    ],
    troubleshooting: [
      {
        symptom: "« Le montant dépasse le reste à payer de cette réception … »",
        cause: "Le total des paiements liés à cette réception dépasserait son montant.",
        check: "Fiche fournisseur → colonne « Payé » de la réception.",
        solution: "Saisir un montant inférieur ou égal au reste, ou enregistrer l'excédent sur le compte du fournisseur.",
        expectedResult: "Le paiement est enregistré et le solde baisse.",
        errorStrings: ["Le montant dépasse le reste à payer de cette réception"],
      },
    ],
    related: ["magasin/receptions"],
    tryNow: { label: "Ouvrir Fournisseurs", href: "/fournisseurs" },
    keywords: ["crédit fournisseur", "solde", "paiement fournisseur", "reste à payer"],
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "magasin/tracabilite",
    title: "Tracer un article",
    category: "magasin",
    tagline: "Scannez un code-barres : où est le stock, d'où il vient, et tout ce qui lui est arrivé.",
    permission: "traceability.view",
    body: [
      { type: "p", text: "La page Traçabilité lit le journal unique des mouvements : réception (avec fournisseur et prix d'achat), transferts, ventes en ligne et en magasin, retours, ajustements, inventaires — chacun avec l'emplacement, l'effet, le solde après, l'auteur et le document d'origine." },
      { type: "callout", tone: "info", title: "Historique ancien", text: "Les mouvements antérieurs à la mise en place de la traçabilité complète n'ont ni variation signée, ni solde, ni document d'origine : ils sont marqués « historique ancien » et jamais reconstitués." },
      { type: "p", text: "Vous ne voyez que les mouvements liés aux canaux qui vous sont attribués : un utilisateur sans canal Magasin ne voit pas les ventes magasin, et inversement." },
    ],
    related: ["magasin/ventes-magasin", "magasin/receptions"],
    tryNow: { label: "Ouvrir Traçabilité", href: "/tracabilite" },
    keywords: ["historique", "code-barres", "provenance", "mouvement"],
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "magasin/codes-barres-et-references",
    title: "Codes-barres, références et catégories",
    category: "magasin",
    tagline: "Chaque article vendable (produit simple ou variation) a une référence unique, des codes-barres et une catégorie.",
    permission: "products.edit",
    body: [
      { type: "p", text: "Le SKU est la référence unique d'un article vendable ; la « référence du modèle » regroupe toutes les tailles et couleurs d'un même modèle. Les codes-barres se rattachent à un produit simple ou à chaque variation — jamais à un produit parent qui a des variations. Plusieurs codes sont possibles, un seul est principal." },
      { type: "p", text: "Un code-barres est opaque : ASODITECH ne déduit jamais la taille ou la couleur d'un code. La recherche essaie d'abord le code-barres, puis la référence/SKU, puis le nom." },
      { type: "p", text: "La référence, les codes-barres et les canaux de vente restent modifiables même pour un produit synchronisé depuis WooCommerce ou Shopify ; son nom, son SKU, son prix et sa catégorie restent gérés sur la plateforme." },
    ],
    troubleshooting: [
      {
        symptom: "« Ce code-barres est déjà utilisé. »",
        cause: "Le code identifie déjà un autre article de votre espace.",
        check: "Traçabilité → chercher le code.",
        solution: "Utiliser le code de l'autre article, ou en saisir un différent.",
        expectedResult: "Le code est ajouté.",
        errorStrings: ["Ce code-barres est déjà utilisé."],
      },
    ],
    related: ["magasin/tracabilite"],
    tryNow: { label: "Ouvrir Produits", href: "/produits" },
    lastUpdated: LAST_UPDATED,
  },
  {
    slug: "magasin/canaux-et-acces",
    title: "Canaux de vente et accès individuels",
    category: "magasin",
    tagline: "En ligne et Magasin sont des canaux : ils séparent l'activité et les accès, sans dupliquer le stock.",
    permission: "channels.manage",
    body: [
      { type: "p", text: "Le stock appartient aux emplacements physiques ; un canal indique seulement où un produit peut être vendu et de quels emplacements il vend. Aucune quantité n'est stockée par canal." },
      { type: "callout", tone: "info", title: "Mode d'activité de l'espace", text: "Toute cette section (ventes magasin, réceptions, fournisseurs, traçabilité, codes-barres, canaux) n'est disponible que si votre espace est en mode « En ligne + Magasin ». Le mode est choisi par l'opérateur de la plateforme à la création de l'espace et peut être changé ; un espace « En ligne seul » fonctionne exactement comme avant et ne voit aucune de ces fonctions. Repasser en « En ligne seul » est refusé tant que l'espace a des ventes, réceptions ou paiements fournisseurs enregistrés." },
      { type: "p", text: "Sur la page Utilisateurs, chaque utilisateur non administrateur peut recevoir des canaux (En ligne, un ou plusieurs magasins) et des ajustements de permissions : « Autoriser » ajoute une permission que son rôle n'a pas, « Refuser » en retire une. Un refus l'emporte toujours. Les propriétaires et administrateurs ne sont jamais restreints." },
      { type: "callout", tone: "warning", title: "Séparation des données", text: "Un utilisateur sans canal En ligne ne voit ni les commandes, ni la livraison, ni les rapports de commandes ; un utilisateur sans canal Magasin ne voit pas les ventes magasin. Ce contrôle est fait côté serveur, pas seulement en masquant des menus." },
    ],
    related: ["magasin/ventes-magasin"],
    tryNow: { label: "Ouvrir les canaux de vente", href: "/parametres/canaux" },
    keywords: ["permissions", "rôle", "accès", "offline", "online"],
    lastUpdated: LAST_UPDATED,
  },
];
