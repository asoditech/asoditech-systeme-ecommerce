"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { getUnitPurchaseHistoryAction } from "@/actions/purchases";
import type { PurchasePriceHistoryEntry } from "@/lib/queries/purchases";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency, formatDate, displayReceptionNumber } from "@/lib/format";
import Link from "next/link";

/**
 * Batch 14 — a variable product's "Dernier achat" cell only shows the
 * latest price (the table has no room for more); this opens the SAME full
 * history the simple-product card shows, scoped to this one variation —
 * never combined with the parent product's own history (docs/adr/0040).
 */
export function VariationPurchaseHistoryDialog({
  variationId,
  label,
  latestUnitCost,
}: {
  variationId: string;
  label: string;
  latestUnitCost: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<PurchasePriceHistoryEntry[] | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && history === null) {
      setLoading(true);
      getUnitPurchaseHistoryAction({ variationId })
        .then(setHistory)
        .finally(() => setLoading(false));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto gap-1 p-0 font-normal text-muted-foreground hover:text-foreground"
          />
        }
      >
        {latestUnitCost != null ? formatCurrency(String(latestUnitCost)) : "—"}
        <History className="size-3" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Historique des achats — {label}</DialogTitle>
        </DialogHeader>
        {loading && <p className="text-sm text-muted-foreground">Chargement…</p>}
        {!loading && history && history.length === 0 && (
          <p className="text-sm text-muted-foreground">Aucun achat validé enregistré pour cette variante.</p>
        )}
        {!loading && history && history.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Fournisseur</TableHead>
                  <TableHead>Réception</TableHead>
                  <TableHead className="text-right">Prix unitaire</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h, i) => (
                  <TableRow key={`${h.receptionId}-${i}`}>
                    <TableCell className="text-muted-foreground">{formatDate(h.date)}</TableCell>
                    <TableCell>{h.supplierName}</TableCell>
                    <TableCell>
                      <Link href={`/receptions/${h.receptionId}`} className="hover:underline">
                        {displayReceptionNumber({ receptionNumber: h.receptionNumber, displayNumber: h.receptionDisplayNumber })}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(String(h.unitCost))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
