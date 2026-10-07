"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";
import { confirmPhysicalReturnAction } from "@/actions/returns";
import { ReturnScanField } from "@/components/returns/return-scan-field";
import { applyReturnScan, type ScannedUnit } from "@/lib/returns/scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface ReturnableOrderLine {
  orderItemId: string;
  nameSnapshot: string;
  skuSnapshot: string;
  /** What EXPEDIEE physically consumed for this line (no split-shipment
   * support — this is simply the order item's own quantity). */
  consumedQuantity: number;
  /** Sum of every prior physical-return event's sellable + damaged
   * quantities for this line. */
  alreadyReturned: number;
  /** Catalogue unit of the line — lets « Scanner » find it (null when the product was deleted). */
  productId?: string | null;
  variationId?: string | null;
}

interface LineDraft {
  sellable: string;
  damaged: string;
}

export function PhysicalReturnDialog({ orderId, lines }: { orderId: string; lines: ReturnableOrderLine[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [note, setNote] = React.useState("");
  const [drafts, setDrafts] = React.useState<Record<string, LineDraft>>({});
  // Generated once when the dialog opens — never regenerated on re-render
  // — so a retry (e.g. a flaky network double-submit) reuses the exact
  // same key and the server-side idempotency guard treats it as a no-op
  // rather than a second return event.
  const idempotencyKeyRef = React.useRef<string | null>(null);

  const returnable = lines.filter((l) => l.consumedQuantity - l.alreadyReturned > 0);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      idempotencyKeyRef.current = crypto.randomUUID();
      setNote("");
      setDrafts({});
    }
  }

  function setDraft(orderItemId: string, field: keyof LineDraft, value: string) {
    setDrafts((prev) => {
      const current = prev[orderItemId] ?? { sellable: "0", damaged: "0" };
      return { ...prev, [orderItemId]: { ...current, [field]: value } };
    });
  }

  /** « Scanner »: +1 revendable on the scanned unit's line, within what remains (src/lib/returns/scan.ts). */
  function applyScan(unit: ScannedUnit) {
    const toInt = (v: string | undefined) => Math.max(0, Math.trunc(Number(v ?? 0)) || 0);
    const result = applyReturnScan(
      lines.map((l) => ({
        id: l.orderItemId,
        label: l.nameSnapshot,
        productId: l.productId ?? null,
        variationId: l.variationId ?? null,
        remaining: l.consumedQuantity - l.alreadyReturned,
        sellable: toInt(drafts[l.orderItemId]?.sellable),
        damaged: toInt(drafts[l.orderItemId]?.damaged),
      })),
      unit,
      "commande"
    );
    if (result.ok) setDraft(result.lineId, "sellable", String(result.sellable));
    return result;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const submittedLines = returnable
      .map((line) => {
        const draft = drafts[line.orderItemId];
        const sellable = Math.max(0, Math.trunc(Number(draft?.sellable ?? 0)) || 0);
        const damaged = Math.max(0, Math.trunc(Number(draft?.damaged ?? 0)) || 0);
        return { orderItemId: line.orderItemId, quantitySellable: sellable, quantityDamaged: damaged, line };
      })
      .filter((l) => l.quantitySellable > 0 || l.quantityDamaged > 0);

    if (submittedLines.length === 0) {
      toast.error("Renseignez au moins une quantité retournée.");
      return;
    }
    for (const l of submittedLines) {
      const remaining = l.line.consumedQuantity - l.line.alreadyReturned;
      if (l.quantitySellable + l.quantityDamaged > remaining) {
        toast.error(`« ${l.line.nameSnapshot} » : quantité saisie supérieure à la quantité restante (${remaining}).`);
        return;
      }
    }

    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID();
    }
    const idempotencyKey = idempotencyKeyRef.current;

    startTransition(async () => {
      const result = await confirmPhysicalReturnAction({
        orderId,
        idempotencyKey,
        note: note.trim().length > 0 ? note.trim() : undefined,
        lines: submittedLines.map((l) => ({
          orderItemId: l.orderItemId,
          quantitySellable: l.quantitySellable,
          quantityDamaged: l.quantityDamaged,
        })),
      });
      if (result.ok) {
        toast.success("Retour physique confirmé.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (returnable.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
        <Undo2 className="size-3.5" />
        Confirmer le retour physique
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Retour physique</DialogTitle>
          <DialogDescription>
            Enregistrez les unités physiquement reçues en retour. Une unité endommagée n&apos;est jamais remise en
            vente — seule une unité revendable augmente le stock disponible.
          </DialogDescription>
        </DialogHeader>
        {/* min-w-0: the 6-column table scrolls inside its own container instead of widening the dialog past the screen. */}
        <form onSubmit={handleSubmit} className="min-w-0 space-y-4">
          <ReturnScanField scope="order" onUnit={applyScan} />
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article</TableHead>
                  <TableHead className="text-right">Expédiée</TableHead>
                  <TableHead className="text-right">Déjà retournée</TableHead>
                  <TableHead className="text-right">Restante</TableHead>
                  <TableHead className="w-24">Revendable</TableHead>
                  <TableHead className="w-24">Endommagée</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {returnable.map((line) => {
                  const remaining = line.consumedQuantity - line.alreadyReturned;
                  const draft = drafts[line.orderItemId] ?? { sellable: "0", damaged: "0" };
                  return (
                    <TableRow key={line.orderItemId}>
                      <TableCell>
                        <p className="font-medium">{line.nameSnapshot}</p>
                        <p className="text-xs text-muted-foreground">{line.skuSnapshot}</p>
                      </TableCell>
                      <TableCell className="text-right">{line.consumedQuantity}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{line.alreadyReturned}</TableCell>
                      <TableCell className="text-right font-medium">{remaining}</TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          max={remaining}
                          step={1}
                          value={draft.sellable}
                          onChange={(e) => setDraft(line.orderItemId, "sellable", e.target.value)}
                          className="h-8 w-20"
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          max={remaining}
                          step={1}
                          value={draft.damaged}
                          onChange={(e) => setDraft(line.orderItemId, "damaged", e.target.value)}
                          className="h-8 w-20"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="physical-return-note">Note (optionnel)</Label>
            <Textarea
              id="physical-return-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Confirmer le retour"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
