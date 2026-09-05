/**
 * Human-readable labels for the audit log — every `AuditEvent.action`
 * code and `entityType` in the codebase mapped to a plain French phrase,
 * plus a coarse category per action (for the Journal d'audit filter) and
 * a link resolver for the entity types cheap to route to without an
 * extra query. Raw dotted action codes ("integration.webhook_rejected")
 * and bare model names ("Integration", a truncated cuid) read as
 * developer/system internals, not something a store owner or their staff
 * can make sense of at a glance.
 */

export type AuditCategory =
  | "commandes"
  | "clients"
  | "produits_stock"
  | "livraison"
  | "finance"
  | "marketing"
  | "integrations"
  | "utilisateurs"
  | "parametres";

export const AUDIT_CATEGORY_LABELS: Record<AuditCategory, string> = {
  commandes: "Commandes",
  clients: "Clients",
  produits_stock: "Produits & stock",
  livraison: "Livraison",
  finance: "Finance",
  marketing: "Marketing",
  integrations: "Intégrations",
  utilisateurs: "Utilisateurs",
  parametres: "Paramètres",
};

interface AuditActionMeta {
  label: string;
  category: AuditCategory;
}

const AUDIT_ACTION_META: Record<string, AuditActionMeta> = {
  "ai.query": { label: "Question posée à l'assistant IA", category: "parametres" },
  "category.created": { label: "Catégorie créée", category: "produits_stock" },
  "customer.address.created": { label: "Adresse client ajoutée", category: "clients" },
  "customer.address.deleted": { label: "Adresse client supprimée", category: "clients" },
  "customer.created": { label: "Client créé", category: "clients" },
  "customer.updated": { label: "Client modifié", category: "clients" },
  "delivery_city_mapping.created": { label: "Correspondance de ville créée", category: "livraison" },
  "delivery_city_mapping.deleted": { label: "Correspondance de ville supprimée", category: "livraison" },
  "delivery_city_mapping.updated": { label: "Correspondance de ville modifiée", category: "livraison" },
  "delivery_manifest.created": { label: "Bon de livraison généré", category: "livraison" },
  "delivery_manifest.failed": { label: "Échec de génération du bon de livraison", category: "livraison" },
  "expense_category.created": { label: "Catégorie de dépense créée", category: "finance" },
  "expense.created": { label: "Dépense enregistrée", category: "finance" },
  "expense.updated": { label: "Dépense modifiée", category: "finance" },
  "integration.connected": { label: "Intégration connectée", category: "integrations" },
  "integration.connection_test_failed": { label: "Test de connexion échoué", category: "integrations" },
  "integration.connection_test_succeeded": { label: "Test de connexion réussi", category: "integrations" },
  "integration.disconnected": { label: "Intégration déconnectée", category: "integrations" },
  "integration.sync_started": { label: "Synchronisation démarrée", category: "integrations" },
  "integration.sync_completed": { label: "Synchronisation terminée", category: "integrations" },
  "integration.sync_partial_failure": { label: "Synchronisation partiellement réussie", category: "integrations" },
  "integration.updated": { label: "Intégration modifiée", category: "integrations" },
  "integration.webhook_received": { label: "Webhook reçu et traité", category: "integrations" },
  "integration.webhook_rejected": { label: "Webhook rejeté (signature invalide)", category: "integrations" },
  "inventory.adjusted": { label: "Stock ajusté manuellement", category: "produits_stock" },
  "inventory.reconciled": { label: "Stock synchronisé depuis la boutique", category: "produits_stock" },
  "marketing_campaign.created": { label: "Campagne marketing créée", category: "marketing" },
  "marketing_channel.created": { label: "Canal marketing créé", category: "marketing" },
  "order.cancelled": { label: "Commande annulée", category: "commandes" },
  "order.created": { label: "Commande créée", category: "commandes" },
  "order.updated": { label: "Commande mise à jour", category: "commandes" },
  "order.status_changed": { label: "Statut de commande modifié", category: "commandes" },
  "order.refund.created": { label: "Remboursement créé", category: "commandes" },
  "order.refund.status_changed": { label: "Statut de remboursement modifié", category: "commandes" },
  "product.created": { label: "Produit créé", category: "produits_stock" },
  "product.updated": { label: "Produit modifié", category: "produits_stock" },
  "product.archived": { label: "Produit archivé", category: "produits_stock" },
  "settings.updated": { label: "Paramètres modifiés", category: "parametres" },
  "shipment.created": { label: "Expédition créée", category: "livraison" },
  "shipment.cancelled": { label: "Expédition annulée", category: "livraison" },
  "shipment.cancellation_failed": { label: "Échec de l'annulation de l'expédition", category: "livraison" },
  "shipment.creation_failed": { label: "Échec de création de l'expédition", category: "livraison" },
  "shipment.status_changed": { label: "Statut d'expédition modifié", category: "livraison" },
  "shipment.status_sync_failed": { label: "Échec de synchronisation du statut d'expédition", category: "livraison" },
  "shipping_provider.api_configured": { label: "Prestataire de livraison configuré", category: "livraison" },
  "shipping_provider.connection_test_failed": { label: "Test de connexion prestataire échoué", category: "livraison" },
  "shipping_provider.connection_test_succeeded": { label: "Test de connexion prestataire réussi", category: "livraison" },
  "shipping_provider.created": { label: "Prestataire de livraison ajouté", category: "livraison" },
  "shipping_provider.deleted": { label: "Prestataire de livraison supprimé", category: "livraison" },
  "stock_transfer.cancelled": { label: "Transfert de stock annulé", category: "produits_stock" },
  "stock_transfer.created": { label: "Transfert de stock créé", category: "produits_stock" },
  "stock_transfer.dispatched": { label: "Transfert de stock expédié", category: "produits_stock" },
  "stock_transfer.received": { label: "Transfert de stock réceptionné", category: "produits_stock" },
  "stocktake.cancelled": { label: "Inventaire annulé", category: "produits_stock" },
  "stocktake.closed": { label: "Inventaire clôturé", category: "produits_stock" },
  "stocktake.created": { label: "Inventaire créé", category: "produits_stock" },
  "user.created": { label: "Utilisateur créé", category: "utilisateurs" },
  "user.login.failure": { label: "Échec de connexion", category: "utilisateurs" },
  "user.login.success": { label: "Connexion réussie", category: "utilisateurs" },
  "user.logout": { label: "Déconnexion", category: "utilisateurs" },
  "user.role_changed": { label: "Rôle utilisateur modifié", category: "utilisateurs" },
  "user.status_changed": { label: "Statut utilisateur modifié", category: "utilisateurs" },
  "warehouse.activated": { label: "Entrepôt réactivé", category: "produits_stock" },
  "warehouse.created": { label: "Entrepôt créé", category: "produits_stock" },
  "warehouse.deactivated": { label: "Entrepôt désactivé", category: "produits_stock" },
  "warehouse.updated": { label: "Entrepôt modifié", category: "produits_stock" },
};

/** A plain-French phrase for an action code — never the raw dev code,
 * even for one not in the table above (a `product.exported` added later,
 * say, still reads as "Product exported" rather than the literal string). */
export function humanizeAuditAction(action: string): string {
  const known = AUDIT_ACTION_META[action]?.label;
  if (known) return known;
  return action
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function auditActionCategory(action: string): AuditCategory | null {
  return AUDIT_ACTION_META[action]?.category ?? null;
}

/** Every known action code belonging to one category — for filtering the
 * audit log at the database level (category isn't a stored column). An
 * action added later with no entry above is simply not filterable by
 * category yet; it still shows up under "Toutes les catégories". */
export function actionsForCategory(category: AuditCategory): string[] {
  return Object.entries(AUDIT_ACTION_META)
    .filter(([, meta]) => meta.category === category)
    .map(([action]) => action);
}

export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  Order: "Commande",
  Customer: "Client",
  CustomerAddress: "Adresse client",
  Product: "Produit",
  ProductVariation: "Variation de produit",
  Category: "Catégorie",
  Integration: "Intégration",
  SyncRun: "Synchronisation",
  InventoryItem: "Article en stock",
  StockTransfer: "Transfert de stock",
  StocktakeSession: "Inventaire",
  Warehouse: "Entrepôt",
  Shipment: "Expédition",
  ShippingProvider: "Prestataire de livraison",
  DeliveryManifest: "Bon de livraison",
  DeliveryCityMapping: "Correspondance de ville",
  Refund: "Remboursement",
  Expense: "Dépense",
  ExpenseCategory: "Catégorie de dépense",
  MarketingCampaign: "Campagne marketing",
  MarketingChannel: "Canal marketing",
  User: "Utilisateur",
  Settings: "Paramètres",
};

export function humanizeAuditEntity(entityType: string): string {
  return AUDIT_ENTITY_LABELS[entityType] ?? entityType;
}

/** Where to link an entity from the audit log, for the handful of types
 * with a real detail page reachable by id alone — cheap (no extra
 * query), so most rows stay just informational text rather than a link. */
export function auditEntityHref(entityType: string, entityId: string): string | null {
  switch (entityType) {
    case "Order":
      return `/commandes/${entityId}`;
    case "Customer":
      return `/clients/${entityId}`;
    case "Product":
      return `/produits/${entityId}`;
    case "StockTransfer":
      return `/transferts/${entityId}`;
    case "StocktakeSession":
      return `/inventaires/${entityId}`;
    case "Integration":
      return "/integrations";
    default:
      return null;
  }
}
