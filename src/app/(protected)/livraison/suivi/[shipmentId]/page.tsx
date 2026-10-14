import Link from "next/link";
import { PhoneActions } from "@/components/phone-actions";
import { notFound } from "next/navigation";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { TrackingStatusBadge } from "@/components/tracking/tracking-status-badge";
import { TrackingTimeline } from "@/components/tracking/tracking-timeline";
import { RefreshTrackingButton } from "@/components/tracking/refresh-tracking-button";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { getTrackingDetail } from "@/lib/queries/tracking";
import { SHIPMENT_STATUS_LABELS, SHIPMENT_COST_SOURCE_LABELS } from "@/lib/status-labels";
import { formatCurrency, formatDateTime, orderShippingCountry } from "@/lib/format";

export const metadata = { title: "Détail du suivi — ASODITECH Gestion E-commerce" };

export default async function SuiviDetailPage({
  params,
}: {
  params: Promise<{ shipmentId: string }>;
}) {
  const user = await requirePermission("delivery.view");
  const canManage = userHasPermission(user, "delivery.manage");
  const includeCosts = userHasPermission(user, "finance.view");
  const { shipmentId } = await params;

  const d = await getTrackingDetail(shipmentId, { includeCosts });
  if (!d) notFound();

  const addressParts = [d.addressLine1, d.addressLine2, d.city, d.region].filter(Boolean);
  const country = orderShippingCountry({ shippingCountry: d.country });

  return (
    <div>
      <PageHeader
        title={`Suivi — ${d.orderLabel}`}
        description={`${d.providerName} · ${d.trackingNumber ?? "sans n° de suivi"}`}
        breadcrumbs={[
          { label: "Livraison", href: "/livraison" },
          { label: "Suivi", href: "/livraison/suivi" },
          { label: d.orderLabel },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" render={<Link href={`/commandes/${d.orderId}`} />}>
              Voir la commande
            </Button>
            {canManage && d.providerSupportsTracking && (
              <RefreshTrackingButton mode="single" shipmentId={d.shipmentId} />
            )}
          </div>
        }
      />

      {d.trackingSyncError && (
        <Notice tone="warning" className="mb-5">
          <AlertTriangle />
          <div>
            <p className="font-medium">La dernière actualisation du suivi a échoué.</p>
            <p className="text-xs">
              {d.trackingSyncError} — le dernier statut et l&apos;historique connus ci-dessous sont conservés tels quels.
            </p>
          </div>
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle accent="purple">Statut</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <TrackingStatusBadge status={d.normalizedStatus} raw={d.providerStatusRaw} />
              <span className="text-xs text-muted-foreground">
                Statut interne : <StatusBadge status={d.localStatus} labels={SHIPMENT_STATUS_LABELS} />
              </span>
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-ink-muted">Statut brut transporteur</dt>
                <dd className="text-ink">{d.providerStatusRaw ?? "Non communiqué"}</dd>
              </div>
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-ink-muted">Dernier évènement</dt>
                <dd className="text-ink">
                  {d.latestEvent
                    ? `${d.latestEvent.label}${d.latestEvent.timestamp ? ` — ${formatDateTime(d.latestEvent.timestamp)}` : ""}`
                    : "Aucun"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-ink-muted">Livré le</dt>
                <dd className="text-ink">{d.deliveredAt ? formatDateTime(d.deliveredAt) : "—"}</dd>
              </div>
              <div className="flex justify-between gap-4 sm:block">
                <dt className="text-ink-muted">Dernière synchro suivi</dt>
                <dd className="text-ink">{d.lastTrackingSyncAt ? formatDateTime(d.lastTrackingSyncAt) : "Jamais"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle accent="blue">Livreur</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {d.courierName || d.courierPhone ? (
              <>
                {d.courierName && <p className="font-medium text-ink">{d.courierName}</p>}
                {d.courierPhone && <PhoneActions phone={d.courierPhone} className="text-muted-foreground" />}
              </>
            ) : (
              <p className="text-muted-foreground">
                Non disponible — ce transporteur ne communique pas les coordonnées du livreur.
              </p>
            )}
            <p className="pt-2 text-xs text-ink-muted">
              À ne pas confondre avec l&apos;agent de confirmation de la commande.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle accent="purple">Destination</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="font-medium text-ink">{d.customerName}</p>
            {d.customerPhone && <PhoneActions phone={d.customerPhone} whatsapp className="text-muted-foreground" />}
            <p className="text-muted-foreground">
              {addressParts.length > 0 ? addressParts.join(", ") : "Adresse non renseignée"}
            </p>
            <p className="text-muted-foreground">{country}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle accent="peach">Colis</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="text-muted-foreground">{d.productsSummary ?? "Contenu non détaillé"}</p>
            <p>
              Valeur commande : <span className="font-medium text-ink tabular-nums">{formatCurrency(d.orderTotal, d.currency)}</span>
            </p>
            {d.trackingUrl && (
              <a
                href={d.trackingUrl}
                target="_blank"
                rel="noreferrer"
                className="text-link inline-flex items-center gap-1"
              >
                Suivi transporteur <ExternalLink className="size-3.5" />
              </a>
            )}
          </CardContent>
        </Card>

        {includeCosts && (
          <Card>
            <CardHeader>
              <CardTitle accent="green">Coût enregistré</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Montant</span>
                <span className="tabular-nums">
                  {d.deliveryCost ?? d.returnCost ?? d.failureCost
                    ? formatCurrency((d.deliveryCost ?? d.returnCost ?? d.failureCost)!, d.currency)
                    : "Inconnu"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Source</span>
                <span>{d.costSource ? SHIPMENT_COST_SOURCE_LABELS[d.costSource] : "—"}</span>
              </div>
              <p className="pt-1 text-xs text-ink-muted">
                Valeur figée par la Livraison (ADR 0032). Cette page ne la recalcule jamais.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle accent="yellow">Historique du transporteur</CardTitle>
        </CardHeader>
        <CardContent>
          {d.events.length > 0 ? (
            <TrackingTimeline events={d.events} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {d.providerSupportsTracking
                ? "Aucun évènement communiqué par le transporteur pour le moment."
                : "Ce transporteur ne fournit pas d'historique de suivi détaillé via son API."}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
