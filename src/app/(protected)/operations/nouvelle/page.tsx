import Link from "next/link";
import { redirect } from "next/navigation";
import { ShoppingCart, Store, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";

export const metadata = { title: "Nouvelle opération — ASODITECH Gestion E-commerce" };

/**
 * The explicit fork the Online/Offline unification was missing (Group 1 of
 * the post-audit UX fixes): before this page, the only way to start a new
 * transaction was to already know whether you wanted /commandes/nouvelle
 * (a delivery Order) or /ventes/nouvelle (an in-store Sale) — two separate,
 * separately-modeled entities (docs/adr/0038, 0040) that a manager could
 * easily confuse, since nothing asked "which one?" up front. This page adds
 * no new business logic: it only routes to the two existing, unmodified
 * creation flows.
 *
 * A user authorized for only one side skips the choice entirely — no extra
 * click for Ahmed (Offline-only) or Sarah (Online-only) from the earlier
 * user-scope examples.
 */
export default async function NouvelleOperationPage() {
  const user = await requireUser();
  const canOrder = userHasPermission(user, "orders.create");
  const canSale = userHasPermission(user, "sales.create");

  if (canOrder && !canSale) redirect("/commandes/nouvelle");
  if (canSale && !canOrder) redirect("/ventes/nouvelle");
  if (!canOrder && !canSale) redirect("/acces-refuse");

  return (
    <div>
      <PageHeader
        title="Nouvelle opération"
        description="Quel type d'opération souhaitez-vous créer ?"
      />
      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Link href="/commandes/nouvelle" className="group">
          <Card className="h-full transition-colors group-hover:border-primary/40">
            <CardContent className="flex flex-col gap-3 pt-6">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ShoppingCart className="size-5" />
              </div>
              <div>
                <p className="font-medium">Commande en ligne</p>
                <p className="text-sm text-muted-foreground">
                  Une commande à livrer : confirmation, préparation, expédition, livraison.
                </p>
              </div>
              <span className="mt-1 inline-flex items-center gap-1 text-sm text-primary">
                Créer une commande <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </CardContent>
          </Card>
        </Link>
        <Link href="/ventes/nouvelle" className="group">
          <Card className="h-full transition-colors group-hover:border-primary/40">
            <CardContent className="flex flex-col gap-3 pt-6">
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Store className="size-5" />
              </div>
              <div>
                <p className="font-medium">Vente magasin</p>
                <p className="text-sm text-muted-foreground">
                  Une vente directe au comptoir : paiement immédiat, décrémente le stock physique tout de suite.
                </p>
              </div>
              <span className="mt-1 inline-flex items-center gap-1 text-sm text-primary">
                Créer une vente <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
