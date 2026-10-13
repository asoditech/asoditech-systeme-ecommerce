"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PackageCheck, X } from "lucide-react";
import { receiveReturnParcelsAction } from "@/actions/return-receiving";
import { ReceiveParcelButton, ReturnParcelStateBadge } from "@/components/returns/returns-workspace";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ReturnParcelView } from "@/lib/queries/return-receiving";
import { BULK_RECEIVE_MAX, isBulkReceivable, returnParcelNextStep, summarizeBulkReceive, type BulkReceiveSummary } from "@/lib/returns/bulk-selection";

/**
 * The workspace's parcel table with row selection: tick parcels « À
 * réceptionner » (or the page's header box) → « Réceptionner la sélection »,
 * confirmed, each parcel received in its own transaction
 * (receiveReturnParcelsAction) and each failure listed. Reception never moves
 * stock; inspection stays one parcel at a time (a condition per unit).
 */
export function ReturnParcelsTable({
  rows,
  receptionText,
}: {
  rows: ReturnParcelView[];
  /** « Réception » cell per shipment, formatted on the server (one time zone, no hydration drift). */
  receptionText: Record<string, string>;
}) {
  const router = useRouter();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [summary, setSummary] = React.useState<BulkReceiveSummary | null>(null);
  const [isPending, startTransition] = React.useTransition();

  // Rows change after a refresh / page change: keep only ids still selectable on this page.
  const selectable = React.useMemo(() => rows.filter(isBulkReceivable).map((r) => r.shipmentId), [rows]);
  const selectedIds = selectable.filter((id) => selected.has(id));
  const allChecked = selectable.length > 0 && selectedIds.length === selectable.length;
  const labelOf = React.useMemo(() => new Map(rows.map((r) => [r.shipmentId, `${r.orderLabel} · ${r.trackingNumber ?? "sans n° de suivi"}`])), [rows]);

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function receiveSelection() {
    const ids = selectedIds.slice(0, BULK_RECEIVE_MAX);
    if (ids.length === 0) return;
    startTransition(async () => {
      try {
        const r = await receiveReturnParcelsAction({ shipmentIds: ids });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        const s = summarizeBulkReceive(r.data);
        setSummary(s);
        if (s.allOk) toast.success(s.message);
        else toast.warning(s.message);
        setSelected(new Set(s.failed.map((f) => f.shipmentId)));
        router.refresh();
      } catch {
        toast.error("Réception impossible — vérifiez vos droits et réessayez.");
      } finally {
        setConfirmOpen(false);
      }
    });
  }

  return (
    <>
      {(selectedIds.length > 0 || summary) && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2 text-sm" role="region" aria-label="Actions sur la sélection">
          {selectedIds.length > 0 && (
            <>
              <span className="font-medium">{selectedIds.length} colis sélectionné(s)</span>
              <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={isPending}>
                <PackageCheck className="size-4" />
                {isPending ? "Réception…" : `Réceptionner la sélection (${selectedIds.length})`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={isPending}>
                Désélectionner
              </Button>
            </>
          )}
          {summary && (
            <div className={`flex w-full items-start justify-between gap-2 text-xs ${summary.allOk ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`} role="status">
              <div>
                <p className="font-medium">{summary.message}</p>
                {summary.failed.length > 0 && (
                  <ul className="mt-1 list-disc pl-4">
                    {summary.failed.map((f) => (
                      <li key={f.shipmentId}>
                        {labelOf.get(f.shipmentId) ?? f.shipmentId} : {f.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Button size="icon" variant="ghost" className="size-6" aria-label="Masquer le résultat" onClick={() => setSummary(null)}>
                <X className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                aria-label="Sélectionner tous les colis à réceptionner de cette page"
                checked={allChecked}
                indeterminate={selectedIds.length > 0 && !allChecked}
                disabled={selectable.length === 0 || isPending}
                onCheckedChange={(on) => setSelected(on ? new Set(selectable) : new Set())}
              />
            </TableHead>
            <TableHead>Commande</TableHead>
            <TableHead>N° de suivi</TableHead>
            <TableHead>Destinataire</TableHead>
            <TableHead>Emplacement d&apos;origine</TableHead>
            <TableHead className="text-right">Unités retournées</TableHead>
            <TableHead>Étape</TableHead>
            <TableHead>Prochaine étape</TableHead>
            <TableHead>Réception</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => {
            const canSelect = isBulkReceivable(p);
            return (
              <TableRow key={p.shipmentId} data-state={selected.has(p.shipmentId) && canSelect ? "selected" : undefined}>
                <TableCell>
                  {canSelect && (
                    <Checkbox
                      aria-label={`Sélectionner ${p.orderLabel}`}
                      checked={selected.has(p.shipmentId)}
                      disabled={isPending}
                      onCheckedChange={(on) => toggle(p.shipmentId, on)}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <Link href={`/commandes/${p.orderId}`} className="font-medium underline-offset-2 hover:underline">
                    {p.orderLabel}
                  </Link>
                </TableCell>
                <TableCell>
                  <div>{p.trackingNumber ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">{p.providerName}</div>
                </TableCell>
                <TableCell>
                  <div>{p.recipientName}</div>
                  <div className="text-xs text-muted-foreground">{[p.recipientPhone, p.city].filter(Boolean).join(" · ") || "—"}</div>
                </TableCell>
                <TableCell>{p.warehouseName ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.returnedUnits} / {p.shippedUnits}
                </TableCell>
                <TableCell>
                  <ReturnParcelStateBadge state={p.state} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{returnParcelNextStep(p)}</TableCell>
                <TableCell className="text-xs">{receptionText[p.shipmentId] ?? "—"}</TableCell>
                <TableCell className="text-right">
                  <ReceiveParcelButton parcel={p} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <AlertDialog open={confirmOpen} onOpenChange={(open) => !isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Réceptionner {selectedIds.length} colis</AlertDialogTitle>
            <AlertDialogDescription>
              Confirmez l&apos;arrivée physique de ces colis à leur emplacement d&apos;origine. Chaque colis est traité
              séparément et son résultat affiché. Aucun stock n&apos;est modifié : les articles seront comptés à
              l&apos;inspection, colis par colis.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={isPending}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction type="button" onClick={receiveSelection} disabled={isPending}>
              {isPending ? "Réception…" : "Confirmer la réception"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
