import {
  Rocket,
  Plug,
  Package,
  Users,
  ShoppingCart,
  Boxes,
  PhoneCall,
  Truck,
  Wallet,
  FileBarChart,
  UserCog,
  Shield,
  Settings,
  LifeBuoy,
  Gauge,
  Store,
  type LucideIcon,
} from "lucide-react";
import type { DocCategoryId } from "./types";
import type { TenantCapability } from "@/lib/tenant/business-mode";

export interface DocCategory {
  id: DocCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
  /**
   * The tenant capability this category documents (docs/adr/0041). A category
   * that documents an Offline feature is not shown, listed, searched or
   * reachable in an ONLINE_ONLY tenant — its business has none of it.
   */
  requiresCapability?: TenantCapability;
}

/** The 15 top-level sections (A–O) of the Documentation/Demo Center, in reading order. */
export const DOC_CATEGORIES: DocCategory[] = [
  { id: "bien-demarrer", label: "Bien démarrer", description: "Présentation, première connexion, checklist de démarrage.", icon: Rocket },
  { id: "integrations", label: "Boutique / Intégrations", description: "WooCommerce, Shopify, synchronisation, webhooks.", icon: Plug },
  { id: "produits", label: "Produits", description: "Produits simples et variables, prix, coûts, stock produit.", icon: Package },
  { id: "clients", label: "Clients", description: "Créer et gérer les clients, adresses, historique.", icon: Users },
  { id: "commandes", label: "Commandes", description: "Créer, confirmer, annuler et traiter une commande.", icon: ShoppingCart },
  { id: "stock", label: "Stock", description: "Entrepôts, mouvements, transferts, inventaires.", icon: Boxes },
  { id: "magasin", label: "Magasin & achats", description: "Ventes en magasin, réceptions, fournisseurs, codes-barres, traçabilité, canaux.", icon: Store, requiresCapability: "offlineSales" },
  { id: "confirmation", label: "Confirmation", description: "Le rôle CONFIRMATION et le workflow de confirmation.", icon: PhoneCall },
  { id: "livraison", label: "Livraison", description: "Transporteurs, expéditions, suivi, COD, retours.", icon: Truck },
  { id: "finance", label: "Finance / Rentabilité", description: "Coût produit, marge, dépenses, rentabilité.", icon: Wallet },
  { id: "rapports", label: "Rapports", description: "Ventes, rentabilité, stock, livraison, clients, trésorerie.", icon: FileBarChart },
  { id: "utilisateurs", label: "Utilisateurs & permissions", description: "Rôles, invitations, mots de passe, accès.", icon: UserCog },
  { id: "sauvegarde", label: "Sauvegarde", description: "Backup local, Google Drive, restauration.", icon: Shield },
  { id: "parametres", label: "Paramètres", description: "Paramètres boutique et modules système.", icon: Settings },
  { id: "abonnement", label: "Abonnement & Utilisation", description: "Forfaits Business et Pro, limites, utilisation, mise à niveau.", icon: Gauge },
  { id: "troubleshooting", label: "Résolution des problèmes", description: "Base de connaissances des erreurs et de leurs solutions.", icon: LifeBuoy },
];

export function getCategory(id: DocCategoryId): DocCategory {
  const cat = DOC_CATEGORIES.find((c) => c.id === id);
  if (!cat) throw new Error(`Unknown doc category: ${id}`);
  return cat;
}

/** Whether a category is available to a tenant with these capabilities. */
export function isCategoryAvailable(id: DocCategoryId, capabilities: ReadonlySet<TenantCapability>): boolean {
  const needed = DOC_CATEGORIES.find((c) => c.id === id)?.requiresCapability;
  return needed === undefined || capabilities.has(needed);
}

export function categoriesFor(capabilities: ReadonlySet<TenantCapability>): DocCategory[] {
  return DOC_CATEGORIES.filter((c) => c.requiresCapability === undefined || capabilities.has(c.requiresCapability));
}
