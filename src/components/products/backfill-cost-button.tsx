"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Wand2 } from "lucide-react";
import { backfillProductCostSnapshotsAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
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

/**
 * Applies the product's current cost to past sales that were recorded
 * before a cost existed. Explicit + confirmed because it changes
 * historical profitability.
 */
export function BackfillCostButton({ productId, missingCount }: { productId: string; missingCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const fd = new FormData();
      fd.set("productId", productId);
      const res = await backfillProductCostSnapshotsAction(fd);
      if (res.ok) {
        toast.success(
          res.data.updated > 0
            ? `${res.data.updated} vente(s) mise(s) à jour avec le coût actuel.`
            : "Aucune vente à compléter."
        );
        setOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Wand2 className="size-4" />
        Appliquer le coût actuel aux {missingCount} vente(s) sans coût
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Compléter le coût des ventes passées ?</AlertDialogTitle>
          <AlertDialogDescription>
            Le coût d&apos;achat actuel du produit sera appliqué à {missingCount} ligne(s) de vente qui n&apos;en avaient
            pas. Cela <strong>modifie le bénéfice affiché sur ces commandes passées</strong> et dans les rapports. Les
            ventes qui ont déjà un coût figé ne sont pas touchées. Action non réversible automatiquement.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
          <AlertDialogAction type="button" disabled={running} onClick={run}>
            {running ? "En cours…" : "Appliquer"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
