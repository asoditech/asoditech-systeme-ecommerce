import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/guards";
import { TrendingUp, PackageMinus, Boxes, Truck, Users, Wallet, FileText, LineChart, Undo2, Sigma } from "lucide-react";

export const metadata = { title: "Rapports — ASODITECH Gestion E-commerce" };

const REPORTS = [
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
const ONLINE_ONLY_HREFS = new Set([
  "/rapports/ventes",
  "/rapports/rentabilite",
  "/rapports/profitabilite",
  "/rapports/livraison",
  "/rapports/retours",
  "/rapports/clients",
  "/rapports/tresorerie",
  "/livraison/factures",
]);

export default async function RapportsPage() {
  const user = await requirePermission("analytics.view");
  // The Online/Offline/Total report belongs to the `storeChannels` capability
  // (docs/adr/0041): an ONLINE_ONLY tenant does not see it.
  const REPORTS_VISIBLE = REPORTS.filter(
    (r) => (r.href !== "/rapports/canaux" || user.capabilities.has("storeChannels")) && (!ONLINE_ONLY_HREFS.has(r.href) || user.channels.online)
  );

  return (
    <div>
      <PageHeader
        title="Rapports"
        description="Rapports d'activité exportables (CSV et impression / PDF), avec filtres de période."
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS_VISIBLE.map((r) => {
          const Icon = r.icon;
          return (
            <Link key={r.href} href={r.href} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/40">
                <CardContent className="flex flex-col gap-2 pt-5">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/12 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <p className="font-medium">{r.title}</p>
                  <p className="text-sm text-muted-foreground">{r.description}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
