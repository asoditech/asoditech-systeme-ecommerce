import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NORMALIZED_TRACKING_LABELS, NORMALIZED_TRACKING_VARIANT } from "@/lib/tracking/status";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { PhoneActions } from "@/components/phone-actions";
import { ProductChips } from "@/components/orders/product-chips";
import type { TrackingRow } from "@/lib/queries/tracking";

/**
 * « Suivi » operational table (docs/adr/0033). Column priority: Commande,
 * Client (+ phone), Ville, Montant, Livreur (+ phone), Situation, Dernier
 * évènement, Produits. Rows stay one/two short lines; the tracking number
 * lives under the order, the last sync time in the event tooltip. The
 * carrier fee is not shown here (finance pages / shipment detail have it).
 */
export function TrackingTable({ rows }: { rows: TrackingRow[] }) {
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
          <TableHead>Produits</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
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
                <PhoneActions phone={r.customerPhone} whatsapp size="sm" className="text-[11px] text-muted-foreground" />
              </TableCell>
              <TableCell className="text-muted-foreground">
                <span className="block max-w-[8rem] truncate">{r.city ?? "—"}</span>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(r.orderTotal, r.currency)}</TableCell>
              <TableCell>
                {r.courierName || r.courierPhone ? (
                  <>
                    {r.courierName && <span className="block max-w-[9rem] truncate">{r.courierName}</span>}
                    <PhoneActions phone={r.courierPhone} whatsapp size="sm" className="text-[11px] text-muted-foreground" />
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
              <TableCell>
                <ProductChips lines={r.productLines} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
