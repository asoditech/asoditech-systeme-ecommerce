import { TrendingUp, PackageMinus, Boxes, Truck, Users, Wallet, FileText, LineChart, Undo2, Sigma } from "lucide-react";
import { userHasPermission, type Permission } from "@/lib/auth/permissions";

/**
 * The reports offered under /rapports — the ONE list, shared by the reports
 * index and the global search « Pages » (src/actions/search.ts), with the
 * one visibility rule. Each report page re-checks server-side anyway.
 */
export const REPORTS = [
  {
    href: "/rapports/canaux",
    icon: Sigma,
    title: "Par canal (En ligne / Magasin / Total)",
    description: "Chiffre d'affaires en ligne, ventes en magasin et total, sans double comptage — par magasin, emplacement et mode de paiement.",
  },
  {
    href: "/rapports/ventes",
    icon: TrendingUp,
    title: "Ventes",
    description: "CA, commandes, panier moyen, taux de confirmation / livraison / retour, avec période de comparaison.",
  },
  {
    href: "/rapports/rentabilite",
    icon: PackageMinus,
    title: "Rentabilité produit",
    description: "Chiffre d'affaires, coût des marchandises, marge brute et marge % par produit et par catégorie.",
  },
  {
    href: "/rapports/profitabilite",
    icon: LineChart,
    title: "Profitabilité",
    description: "CA, coût des produits et frais de livraison attribués, par produit et par campagne/source — avec détail des commandes.",
  },
  {
    href: "/rapports/stock",
    icon: Boxes,
    title: "Valorisation & rotation du stock",
    description: "Valeur du stock au coût et au prix de vente, par entrepôt, et articles dormants.",
  },
  {
    href: "/rapports/livraison",
    icon: Truck,
    title: "Performance livraison",
    description: "Taux de livraison / échec / retour et délai moyen par transporteur et par ville, COD encaissé vs en attente.",
  },
  {
    href: "/rapports/retours",
    icon: Undo2,
    title: "Retours",
    description: "Unités revendables vs endommagées reçues en retour physique, par produit et par commande.",
  },
  {
    href: "/rapports/clients",
    icon: Users,
    title: "Clients",
    description: "Nouveaux vs récurrents, taux de réachat, meilleurs clients, répartition par ville.",
  },
  {
    href: "/rapports/tresorerie",
    icon: Wallet,
    title: "Trésorerie",
    description: "Encaissements (par mode de paiement) vs dépenses (par catégorie) et frais de livraison — trésorerie nette.",
  },
  {
    href: "/livraison/factures",
    icon: FileText,
    title: "Factures de livraison",
    description: "Générer et imprimer une facture par expédition, avec l'en-tête de la boutique.",
  },
];

// Every report except the stock valuation aggregates delivery ORDERS, so it
// is only offered (and only openable — each page re-checks server-side) to a
// user with an ONLINE channel (docs/adr/0039). The channel report (Online /
// Offline / Total — docs/adr/0040) is added at the end of REPORTS_ALL below.
/** Finance reports (margins, cost of goods, profit, treasury) — `finance.view` (docs/adr/0050). */
export const FINANCE_HREFS = new Set(["/rapports/rentabilite", "/rapports/profitabilite", "/rapports/tresorerie"]);

export const ONLINE_ONLY_HREFS = new Set([
  "/rapports/ventes",
  "/rapports/rentabilite",
  "/rapports/profitabilite",
  "/rapports/livraison",
  "/rapports/retours",
  "/rapports/clients",
  "/rapports/tresorerie",
  "/livraison/factures",
]);


/** The reports this viewer (already holding analytics.view) may open. */
export function visibleReports(user: { permissions: ReadonlySet<Permission>; capabilities: ReadonlySet<string>; channels: { online: boolean } }) {
  // The Online/Offline/Total report belongs to the `storeChannels` capability
  // (docs/adr/0041): an ONLINE_ONLY tenant does not see it.
  return REPORTS.filter(
    (r) =>
      (r.href !== "/rapports/canaux" || user.capabilities.has("storeChannels")) &&
      (!ONLINE_ONLY_HREFS.has(r.href) || user.channels.online) &&
      (!FINANCE_HREFS.has(r.href) || userHasPermission(user, "finance.view"))
  );
}
