type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

interface StatusMeta {
  label: string;
  variant: BadgeVariant;
}

export const ORDER_STATUS_LABELS: Record<string, StatusMeta> = {
  NOUVELLE: { label: "Nouvelle", variant: "secondary" },
  CONFIRMEE: { label: "Confirmée", variant: "default" },
  EN_PREPARATION: { label: "En préparation", variant: "default" },
  EXPEDIEE: { label: "Expédiée", variant: "default" },
  LIVREE: { label: "Livrée", variant: "default" },
  ANNULEE: { label: "Annulée", variant: "outline" },
  RETOUR: { label: "Retour", variant: "destructive" },
  REMBOURSEE: { label: "Remboursée", variant: "outline" },
  ECHEC: { label: "Échec", variant: "destructive" },
};

export const ORDER_PAYMENT_STATUS_LABELS: Record<string, StatusMeta> = {
  EN_ATTENTE: { label: "En attente", variant: "secondary" },
  PAYE: { label: "Payé", variant: "default" },
  PARTIELLEMENT_PAYE: { label: "Partiellement payé", variant: "secondary" },
  ECHEC: { label: "Échec", variant: "destructive" },
  REMBOURSE: { label: "Remboursé", variant: "outline" },
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  PAIEMENT_LIVRAISON: "Paiement à la livraison",
  VIREMENT_BANCAIRE: "Virement bancaire",
  CARTE_BANCAIRE: "Carte bancaire",
  MOBILE_MONEY: "Mobile money",
  AUTRE: "Autre",
};

export const PRODUCT_STATUS_LABELS: Record<string, StatusMeta> = {
  ACTIF: { label: "Actif", variant: "default" },
  BROUILLON: { label: "Brouillon", variant: "secondary" },
  ARCHIVE: { label: "Archivé", variant: "outline" },
};

export const RECORD_SOURCE_LABELS: Record<string, string> = {
  INTERNE: "Interne",
  WOOCOMMERCE: "WooCommerce",
  SHOPIFY: "Shopify",
};

export const SHIPMENT_STATUS_LABELS: Record<string, StatusMeta> = {
  EN_ATTENTE: { label: "En attente", variant: "secondary" },
  EN_TRANSIT: { label: "En transit", variant: "default" },
  LIVRE: { label: "Livré", variant: "default" },
  ECHEC: { label: "Échec", variant: "destructive" },
  RETOURNE: { label: "Retourné", variant: "destructive" },
  ANNULE: { label: "Annulé", variant: "outline" },
};

export const SHIPPING_PROVIDER_TYPE_LABELS: Record<string, string> = {
  MANUEL: "Manuel",
  FLOTTE_INTERNE: "Flotte interne",
  API: "API",
};

export const REFUND_STATUS_LABELS: Record<string, StatusMeta> = {
  EN_ATTENTE: { label: "En attente", variant: "secondary" },
  APPROUVE: { label: "Approuvé", variant: "default" },
  REJETE: { label: "Rejeté", variant: "destructive" },
  COMPLETE: { label: "Complété", variant: "default" },
};

export const CAMPAIGN_STATUS_LABELS: Record<string, StatusMeta> = {
  BROUILLON: { label: "Brouillon", variant: "secondary" },
  ACTIVE: { label: "Active", variant: "default" },
  EN_PAUSE: { label: "En pause", variant: "outline" },
  TERMINEE: { label: "Terminée", variant: "outline" },
};

export const MARKETING_CHANNEL_TYPE_LABELS: Record<string, string> = {
  META: "Meta Ads",
  GOOGLE: "Google Ads",
  TIKTOK: "TikTok Ads",
  AUTRE: "Autre",
};

export const INTEGRATION_PROVIDER_LABELS: Record<string, string> = {
  WOOCOMMERCE: "WooCommerce",
  SHOPIFY: "Shopify",
  META_ADS: "Meta Ads",
  GOOGLE_ADS: "Google Ads",
  TIKTOK_ADS: "TikTok Ads",
  WHATSAPP: "WhatsApp",
  EMAIL: "E-mail",
  GOOGLE_SHEETS: "Google Sheets",
  AI_PROVIDER: "Fournisseur IA",
};

export const INTEGRATION_STATUS_LABELS: Record<string, StatusMeta> = {
  DECONNECTE: { label: "Déconnecté", variant: "secondary" },
  CONNECTE: { label: "Connecté", variant: "default" },
  ERREUR: { label: "Erreur", variant: "destructive" },
};

export const SYNC_RUN_STATUS_LABELS: Record<string, StatusMeta> = {
  EN_COURS: { label: "En cours", variant: "secondary" },
  SUCCES: { label: "Succès", variant: "default" },
  ECHEC: { label: "Échec", variant: "destructive" },
  PARTIEL: { label: "Partiel", variant: "outline" },
};

export const USER_ROLE_LABELS: Record<string, string> = {
  OWNER: "Propriétaire",
  ADMIN: "Administrateur",
  MANAGER: "Manager",
  SALES: "Ventes",
  WAREHOUSE: "Entrepôt",
  DELIVERY: "Livraison",
  SUPPORT: "Support",
  ACCOUNTANT: "Comptable",
};

export const USER_STATUS_LABELS: Record<string, StatusMeta> = {
  ACTIVE: { label: "Actif", variant: "default" },
  DISABLED: { label: "Désactivé", variant: "secondary" },
};

export const CUSTOMER_SEGMENT_LABELS: Record<string, string> = {
  NOUVEAU: "Nouveau client",
  ACTIF: "Client actif",
  FIDELE: "Client fidèle",
  A_RISQUE: "Client à risque",
  INACTIF: "Client inactif",
  VIP: "VIP",
};

export const INVENTORY_MOVEMENT_TYPE_LABELS: Record<string, string> = {
  RECEPTION: "Réception",
  VENTE: "Vente",
  RETOUR: "Retour",
  ENDOMMAGE: "Endommagé",
  AJUSTEMENT_POSITIF: "Ajustement positif",
  AJUSTEMENT_NEGATIF: "Ajustement négatif",
  RESERVATION: "Réservation",
  LIBERATION: "Libération",
};

export const NOTIFICATION_TYPE_LABELS: Record<string, string> = {
  STOCK_FAIBLE: "Stock faible",
  RUPTURE_STOCK: "Rupture de stock",
  NOUVELLE_COMMANDE: "Nouvelle commande",
  ECHEC_LIVRAISON: "Échec de livraison",
  COMMANDE_RETOURNEE: "Commande retournée",
  PROBLEME_PAIEMENT: "Problème de paiement",
  ERREUR_INTEGRATION: "Erreur d'intégration",
  ECHEC_SYNCHRONISATION: "Échec de synchronisation",
};
