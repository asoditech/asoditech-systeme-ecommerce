import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, PackageCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReturnInspectionForm } from "@/components/returns/return-inspection-form";
import { CancelReceptionButton } from "@/components/returns/cancel-reception-dialog";
import { ReturnParcelStateBadge } from "@/components/returns/returns-workspace";
import { requirePermission } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import { getReceptionForInspection } from "@/lib/queries/return-receiving";

export const metadata = { title: "Inspection d'un retour — ASODITECH Gestion E-commerce" };

/**
 * P3 — inspection of one received parcel. Not found (another tenant, an
 * unknown id, or a location the user can't read): the same 404, no detail.
 */
export default async function InspectionRetourPage({ params }: { params: Promise<{ receptionId: string }> }) {
  const user = await requirePermission("orders.return");
  const { receptionId } = await params;
  const view = await getReceptionForInspection(receptionId, user);
  if (!view) notFound();
  const { parcel } = view;

  return (
    <div className="space-y-4">
      <h1 className="flex flex-wrap items-center gap-1.5 text-xl font-semibold tracking-tight">
        <Link href="/livraison/retours" className="text-muted-foreground transition-colors hover:text-foreground">
          Retours colis
        </Link>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
        Inspection — {parcel.trackingNumber ?? parcel.orderLabel}
      </h1>

      <dl className="grid gap-x-6 gap-y-2 rounded-lg border bg-card p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Commande</dt>
          <dd>
            <Link href={`/commandes/${parcel.orderId}`} className="font-medium underline-offset-2 hover:underline">
              {parcel.orderLabel}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Transporteur · n° de suivi</dt>
          <dd>
            {parcel.providerName} · {parcel.trackingNumber ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Destinataire</dt>
          <dd>
            {parcel.recipientName}
            {parcel.city ? ` · ${parcel.city}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Emplacement d&apos;origine</dt>
          <dd>{view.warehouseName}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Réceptionné</dt>
          <dd>
            {formatDateTime(view.receivedAt)}
            {view.receivedByName ? ` · ${view.receivedByName}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Étape</dt>
          <dd>
            <ReturnParcelStateBadge state={view.status === "INSPECTE" ? "INSPECTE" : "A_INSPECTER"} />
          </dd>
        </div>
      </dl>

      {view.status === "INSPECTE" ? (
        <div className="space-y-3 rounded-lg border bg-card p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <PackageCheck className="size-4 text-emerald-600" aria-hidden="true" />
            Inspection terminée{view.inspectedAt ? ` le ${formatDateTime(view.inspectedAt)}` : ""}
            {view.inspectedByName ? ` par ${view.inspectedByName}` : ""}.
          </p>
          <p className="text-muted-foreground">Le détail des unités retournées figure sur la commande.</p>
          <Button size="sm" variant="outline" render={<Link href={`/commandes/${parcel.orderId}`} />}>
            Voir la commande
          </Button>
        </div>
      ) : (
        <>
          <ReturnInspectionForm receptionId={view.receptionId} lines={view.lines} />
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3 text-sm">
            <p className="text-muted-foreground">
              Colis vide, mauvais colis ou unités déjà retournées par ailleurs ? Annulez la réception plutôt que de l&apos;inspecter.
            </p>
            <CancelReceptionButton receptionId={view.receptionId} />
          </div>
        </>
      )}
    </div>
  );
}
