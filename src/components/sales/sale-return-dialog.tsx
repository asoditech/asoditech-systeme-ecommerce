"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";
import { createSaleReturnAction } from "@/actions/sales";
import { ReturnScanField } from "@/components/returns/return-scan-field";
import { applyReturnScan, type ScannedUnit } from "@/lib/returns/scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

interface ReturnableLine {
  id: string;
  label: string;
  sold: number;
  /** Already returned (sellable + damaged) on earlier returns. */
  returned: number;
  /** Catalogue unit of the line — lets « Scanner » find it. */
  productId?: string | null;
  variationId?: string | null;
}

/**
 * Return against an in-store sale (docs/adr/0040). Stock only comes back when
 * physically accepted: SELLABLE units are credited to stock, DAMAGED ones are
 * recorded but never added to sellable stock. The server hard-caps the total by
 * what was sold; one idempotency key per dialog opening prevents a double
 * submit from returning twice.
 */
export function SaleReturnDialog({ saleId, lines, refundable }: { saleId: string; lines: ReturnableLine[]; refundable: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const key = useRef(crypto.randomUUID());
  const [qty, setQty] = useState<Record<string, { sellable: number; damaged: number }>>({});
  const [refund, setRefund] = useState(0);
  const [method, setMethod] = useState("ESPECES");
  const [note, setNote] = useState("");

  const chosen = lines.filter((l) => (qty[l.id]?.sellable ?? 0) + (qty[l.id]?.damaged ?? 0) > 0);

  /** « Scanner »: +1 revendable on the scanned unit's line, within what remains (src/lib/returns/scan.ts). */
  function applyScan(unit: ScannedUnit) {
    const result = applyReturnScan(
      lines.map((l) => ({
        id: l.id,
        label: l.label,
        productId: l.productId ?? null,
        variationId: l.variationId ?? null,
        remaining: l.sold - l.returned,
        sellable: qty[l.id]?.sellable ?? 0,
        damaged: qty[l.id]?.damaged ?? 0,
      })),
      unit,
      "vente"
    );
    if (result.ok) setQty((p) => ({ ...p, [result.lineId]: { sellable: result.sellable, damaged: p[result.lineId]?.damaged ?? 0 } }));
    return result;
  }

  function submit() {
    startTransition(async () => {
      const r = await createSaleReturnAction({
        saleId,
        idempotencyKey: key.current,
        lines: chosen.map((l) => ({ saleLineId: l.id, quantitySellable: qty[l.id]?.sellable ?? 0, quantityDamaged: qty[l.id]?.damaged ?? 0 })),
        refundAmount: refund,
        refundMethod: refund > 0 ? (method as "ESPECES") : null,
        note,
      });
      if (r.ok) {
        toast.success("Retour enregistré.");
        key.current = crypto.randomUUID();
        setOpen(false);
        setQty({});
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} disabled={lines.every((l) => l.sold - l.returned <= 0)}>
        <Undo2 className="size-4" />
        Enregistrer un retour
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Retour de vente</DialogTitle>
          </DialogHeader>
          <ReturnScanField scope="sale" onUnit={applyScan} />
          <div className="divide-y rounded-md border text-sm">
            {lines.map((l) => {
              const remaining = l.sold - l.returned;
              return (
                <div key={l.id} className="grid items-center gap-2 p-3 sm:grid-cols-[1fr_7rem_7rem]">
                  <div>
                    <div className="font-medium">{l.label}</div>
                    <div className="text-xs text-muted-foreground">vendu {l.sold} · déjà retourné {l.returned} · retournable {remaining}</div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Revendable</Label>
                    <Input type="number" min={0} max={remaining} disabled={remaining <= 0} value={qty[l.id]?.sellable ?? 0} onChange={(e) => setQty((p) => ({ ...p, [l.id]: { sellable: Math.max(0, Number(e.target.value) || 0), damaged: p[l.id]?.damaged ?? 0 } }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Endommagé</Label>
                    <Input type="number" min={0} max={remaining} disabled={remaining <= 0} value={qty[l.id]?.damaged ?? 0} onChange={(e) => setQty((p) => ({ ...p, [l.id]: { damaged: Math.max(0, Number(e.target.value) || 0), sellable: p[l.id]?.sellable ?? 0 } }))} />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ret-refund">Remboursement (max {refundable.toFixed(2)})</Label>
              <Input id="ret-refund" type="number" min={0} max={refundable} step="0.01" value={refund} onChange={(e) => setRefund(Math.max(0, Number(e.target.value) || 0))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ret-method">Mode</Label>
              <NativeSelect id="ret-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(CASH_PAYMENT_METHOD_LABELS).map(([k, lab]) => (
                  <option key={k} value={k}>{lab}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ret-note">Note</Label>
              <Input id="ret-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>Annuler</Button>
            <Button type="button" onClick={submit} disabled={isPending || chosen.length === 0}>
              {isPending ? "Enregistrement..." : "Confirmer le retour"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
