"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { receiveStockTransferAction } from "@/actions/transfers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface ReceiveLine {
  id: string;
  label: string;
  sku: string;
  quantitySent: number;
}

export function TransferReceiveForm({
  transferId,
  lines,
}: {
  transferId: string;
  lines: ReceiveLine[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  // Per-line received quantity — defaults to the sent quantity.
  const [received, setReceived] = React.useState<Record<string, number>>(
    () => Object.fromEntries(lines.map((l) => [l.id, l.quantitySent]))
  );

  function setQty(lineId: string, value: number, max: number) {
    setReceived((prev) => ({ ...prev, [lineId]: Math.max(0, Math.min(max, value)) }));
  }

  function handleConfirm() {
    startTransition(async () => {
      const result = await receiveStockTransferAction({
        id: transferId,
        lines: lines.map((l) => ({ lineId: l.id, quantityReceived: received[l.id] ?? 0 })),
      });
      if (result.ok) {
        toast.success("Transfert reçu — stock ajouté à la destination.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Article</TableHead>
            <TableHead>Envoyé</TableHead>
            <TableHead>Reçu</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>
                <p className="font-medium">{l.label}</p>
                <p className="text-xs text-muted-foreground">{l.sku}</p>
              </TableCell>
              <TableCell>{l.quantitySent}</TableCell>
              <TableCell>
                <Input
                  type="number"
                  min="0"
                  max={l.quantitySent}
                  className="w-24"
                  value={received[l.id] ?? 0}
                  onChange={(e) => setQty(l.id, Number(e.target.value), l.quantitySent)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <Button type="button" onClick={() => setOpen(true)}>
          Confirmer la réception
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer la réception ?</AlertDialogTitle>
            <AlertDialogDescription>
              Les quantités reçues seront ajoutées au stock de la destination. Un écart éventuel
              (perte / casse en transit) est enregistré et n&apos;est pas rendu à la source.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={handleConfirm} disabled={isPending}>
              {isPending ? "En cours..." : "Confirmer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
