import type { ReactNode } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { OverrideShipmentCostDialog } from "@/components/delivery/override-shipment-cost-dialog";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { SHIPMENT_COST_SOURCE_LABELS, SHIPMENT_STATUS_LABELS } from "@/lib/status-labels";
import {
  carrierReference,
  lastTrackingEvent,
  safeTrackingUrl,
  shipmentConnectionLabel,
  splitShipmentsForDisplay,
} from "@/lib/orders/delivery-info";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

/**
 * « Informations de livraison » on the order page — what is STORED about the
 * order's shipments, nothing derived or guessed. Read-only; every value is
 * shown only when present. Visibility follows the existing boundaries:
 *   - delivery costs: finance permission (as in « Suivi », includeCosts);
 *   - courier, carrier events, sync state and the « Voir le suivi » link:
 *     delivery.view (they otherwise only exist in /livraison/suivi);
 *   - creating / linking a shipment: delivery.manage (passed in `actions`).
 */

export interface OrderDeliveryShipment {
  id: string;
  status: ShipmentStatusValue;
  providerStatusRaw: string | null;
  providerName: string;
  providerType: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  externalId: string | null;
  courierName: string | null;
  courierPhone: string | null;
  failedReason: string | null;
  trackingSyncError: string | null;
  trackingEvents: unknown;
  createdAt: Date;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  lastSyncedAt: Date | null;
  lastTrackingSyncAt: Date | null;
  cost: string | null;
  costSource: string | null;
  costFinalized: boolean;
}

interface Visibility {
  canViewCosts: boolean;
  canOverrideCost: boolean;
  canViewDelivery: boolean;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function TrackingValue({ s }: { s: OrderDeliveryShipment }) {
  if (!s.trackingNumber) return <span className="text-muted-foreground">—</span>;
  const href = safeTrackingUrl(s.trackingUrl);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono underline-offset-2 hover:underline">
      {s.trackingNumber}
    </a>
  ) : (
    <span className="font-mono">{s.trackingNumber}</span>
  );
}

function latestSync(s: OrderDeliveryShipment): Date | null {
  const times = [s.lastSyncedAt, s.lastTrackingSyncAt].filter((d): d is Date => d !== null);
  return times.length > 0 ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

function formatEventTime(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? timestamp : formatDateTime(d);
}

function PrimaryShipment({ s, currency, v }: { s: OrderDeliveryShipment; currency: string; v: Visibility }) {
  const reference = carrierReference(s.externalId, s.trackingNumber);
  const event = v.canViewDelivery ? lastTrackingEvent(s.trackingEvents) : null;
  const sync = v.canViewDelivery ? latestSync(s) : null;
  return (
    <div className="space-y-3 rounded-tile border border-hairline p-4" data-testid="primary-shipment">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{s.providerName}</span>
        <Badge variant="outline">{shipmentConnectionLabel(s.providerType, s.externalId)}</Badge>
        <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
        {v.canViewDelivery && (
          <Link href={`/livraison/suivi/${s.id}`} className="text-link ml-auto text-sm">
            Voir le suivi
          </Link>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        <Field label="N° de suivi">
          <TrackingValue s={s} />
        </Field>
        {reference && <Field label="Réf. transporteur"><span className="font-mono">{reference}</span></Field>}
        {s.providerStatusRaw && <Field label="Statut transporteur">{s.providerStatusRaw}</Field>}
        {v.canViewDelivery && (s.courierName || s.courierPhone) && (
          <Field label="Livreur">
            {[s.courierName, s.courierPhone].filter(Boolean).join(" · ")}
          </Field>
        )}
        <Field label="Créée le">{formatDateTime(s.createdAt)}</Field>
        {s.shippedAt && <Field label="Expédiée le">{formatDateTime(s.shippedAt)}</Field>}
        {s.deliveredAt && <Field label="Livrée le">{formatDateTime(s.deliveredAt)}</Field>}
        {sync && <Field label="Dernière synchronisation">{formatDateTime(sync)}</Field>}
        {v.canViewCosts && (
          <Field label="Frais de livraison">
            {s.cost !== null ? formatCurrency(s.cost, currency) : "— (inconnu)"}
            {s.costSource && (
              <span className="block text-xs text-muted-foreground">
                {SHIPMENT_COST_SOURCE_LABELS[s.costSource] ?? s.costSource}
                {s.costFinalized ? "" : " (estimation)"}
              </span>
            )}
            {v.canOverrideCost && (
              <span className="mt-1 block">
                <OverrideShipmentCostDialog shipmentId={s.id} currentCost={s.cost} />
              </span>
            )}
          </Field>
        )}
      </dl>
      {event && (
        <p className="text-sm">
          <span className="text-muted-foreground">Dernier évènement : </span>
          {event.label}
          {event.location ? ` — ${event.location}` : ""}
          {formatEventTime(event.timestamp) ? (
            <span className="text-muted-foreground"> ({formatEventTime(event.timestamp)})</span>
          ) : null}
        </p>
      )}
      {s.failedReason && <p className="text-sm text-destructive">Motif d&apos;échec : {s.failedReason}</p>}
      {v.canViewDelivery && s.trackingSyncError && (
        <p className="text-sm text-pill-yellow-fg">Erreur de synchronisation : {s.trackingSyncError}</p>
      )}
    </div>
  );
}

function PreviousShipments({ shipments, currency, v }: { shipments: OrderDeliveryShipment[]; currency: string; v: Visibility }) {
  return (
    <div className="space-y-2" data-testid="previous-shipments">
      <p className="text-sm font-medium">Expéditions précédentes</p>
      <ul className="divide-y divide-hairline rounded-tile border border-hairline">
        {shipments.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span>{s.providerName}</span>
            <TrackingValue s={s} />
            <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
            <span className="text-muted-foreground">{formatDateTime(s.createdAt)}</span>
            {v.canViewCosts && s.cost !== null && (
              <span className="text-muted-foreground">{formatCurrency(s.cost, currency)}</span>
            )}
            {s.failedReason && <span className="w-full text-xs text-destructive">Motif : {s.failedReason}</span>}
            {v.canViewDelivery && (
              <Link href={`/livraison/suivi/${s.id}`} className="text-link ml-auto">
                Voir le suivi
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OrderDeliveryInfo({
  shipments,
  currency,
  codAmount,
  canViewCosts,
  canOverrideCost,
  canViewDelivery,
  actions,
}: {
  shipments: OrderDeliveryShipment[];
  currency: string;
  /** « À encaisser » — computed by the page with the existing COD rule; null when not COD. */
  codAmount: number | null;
  actions?: ReactNode;
} & Visibility) {
  const v: Visibility = { canViewCosts, canOverrideCost, canViewDelivery };
  const { primary, previous } = splitShipmentsForDisplay(shipments);
  return (
    <div className="space-y-4">
      {primary ? (
        <PrimaryShipment s={primary} currency={currency} v={v} />
      ) : (
        <p className="text-sm text-muted-foreground">Aucune expédition associée à cette commande.</p>
      )}
      {codAmount !== null && (
        <p className="text-sm text-muted-foreground">
          À encaisser à la livraison (COD) :{" "}
          <span className="text-foreground">{formatCurrency(String(codAmount), currency)}</span>
        </p>
      )}
      {previous.length > 0 && <PreviousShipments shipments={previous} currency={currency} v={v} />}
      {actions}
    </div>
  );
}
