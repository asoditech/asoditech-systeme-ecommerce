import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NORMALIZED_TRACKING_LABELS, NORMALIZED_TRACKING_VARIANT } from "@/lib/tracking/status";
import { formatCurrency, formatDateTime } from "@/lib/format";
import type { TrackingRow } from "@/lib/queries/tracking";

/**
 * « Suivi » operational table (docs/adr/0033). Column priority: Commande,
 * Client, Ville, Montant, Livreur, Situation, Dernier évènement, then the
 * carrier fee (finance only). Rows stay one/two short lines; the tracking
 * number lives under the order, the last sync time in the event tooltip.
 */
export function TrackingTable({ rows, includeCosts }: { rows: TrackingRow[]; includeCosts: boolean }) {
  return (
    <Table className="text-[13px] [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card [&_th]:px-2.5">
      <TableHeader>
        <TableRow>
          <TableHead>Commande</TableHead>
          <TableHead>Client</TableHead>
          <TableHead>Ville</TableHead>
          <TableHead className="text-right">Montant</TableHead>
          <TableHead>Livreur</TableHead>
          <TableHead>Situation</TableHead>
          <TableHead>Dernier évènement</TableHead>
          {includeCosts && <TableHead className="text-right">Frais transporteur</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          // The parcel's own recorded charge, by outcome — a delivered parcel
          // carries a delivery fee, a RETOUR / ECHEC one its return / failure
          // charge (docs/adr/0032). Never mistaken for the order amount.
          const fee =
            r.costSource === "RETURN_RULE"
              ? { amount: r.returnCost, label: "Retour" }
              : r.costSource === "FAILURE_RULE"
                ? { amount: r.failureCost, label: "Échec" }
                : { amount: r.deliveryCost, label: null as string | null };
          // The carrier's own wording first (« Mise en distribution »,
          // « Pas de réponse + SMS »), coloured by the normalized status.
          const situation = r.providerStatusRaw?.trim() || NORMALIZED_TRACKING_LABELS[r.normalizedStatus];
          const event = r.latestEvent;
          const eventText = event && event.label.trim() !== r.providerStatusRaw?.trim() ? event.label : null;
          const syncTitle = `Dernière synchro : ${r.lastTrackingSyncAt ? formatDateTime(r.lastTrackingSyncAt) : "jamais"}`;
          return (
            <TableRow key={r.shipmentId}>
              <TableCell>
                <Link href={`/livraison/suivi/${r.shipmentId}`} className="font-medium hover:underline">
                  {r.orderLabel}
                </Link>
                {r.trackingNumber && (
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    {r.trackingUrl ? (
                      <a href={r.trackingUrl} target="_blank" rel="noreferrer" className="hover:underline">
                        {r.trackingNumber}
                      </a>
                    ) : (
                      r.trackingNumber
                    )}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <span className="block max-w-[10rem] truncate">{r.customerName}</span>
              </TableCell>
              <TableCell className="text-muted-foreground">
                <span className="block max-w-[8rem] truncate">{r.city ?? "—"}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(r.orderTotal, r.currency)}</TableCell>
              <TableCell>
                {r.courierName || r.courierPhone ? (
                  <>
                    {r.courierName && <span className="block max-w-[9rem] truncate">{r.courierName}</span>}
                    {r.courierPhone && (
                      <a href={`tel:${r.courierPhone}`} className="block text-[11px] text-muted-foreground tabular-nums hover:underline">
                        {r.courierPhone}
                      </a>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <Badge
                  variant={NORMALIZED_TRACKING_VARIANT[r.normalizedStatus]}
                  className="max-w-[12rem] truncate"
                  title={NORMALIZED_TRACKING_LABELS[r.normalizedStatus]}
                >
                  {situation}
                </Badge>
              </TableCell>
              <TableCell className="max-w-[14rem] text-xs text-muted-foreground" title={syncTitle}>
                {r.trackingSyncError ? (
                  <span className="text-amber-600 dark:text-amber-400">Synchro en échec — dernier statut conservé</span>
                ) : event ? (
                  <>
                    {eventText && <span className="block truncate text-foreground">{eventText}</span>}
                    <span className="block text-[11px] text-muted-foreground/80">
                      {event.timestamp ? formatDateTime(event.timestamp) : "—"}
                      {event.location ? ` · ${event.location}` : ""}
                    </span>
                  </>
                ) : (
                  "—"
                )}
              </TableCell>
              {includeCosts && (
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fee.amount !== null ? formatCurrency(fee.amount, r.currency) : "—"}
                  {fee.label && <span className="block text-[11px] text-muted-foreground/70">{fee.label}</span>}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
