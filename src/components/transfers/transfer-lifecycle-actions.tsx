"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Truck, XCircle } from "lucide-react";
import { dispatchStockTransferAction, cancelStockTransferAction } from "@/actions/transfers";
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

export function TransferLifecycleActions({ transferId }: { transferId: string }) {
  const router = useRouter();
  const [dispatchOpen, setDispatchOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  function run(
    action: () => Promise<{ ok: boolean; error?: string }>,
    successMessage: string,
    close: () => void
  ) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(successMessage);
        close();
        router.refresh();
      } else {
        toast.error(result.error ?? "Une erreur est survenue.");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <AlertDialog open={dispatchOpen} onOpenChange={setDispatchOpen}>
        <Button type="button" onClick={() => setDispatchOpen(true)}>
          <Truck className="size-4" />
          Expédier
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Expédier ce transfert ?</AlertDialogTitle>
            <AlertDialogDescription>
              Les quantités envoyées seront immédiatement déduites du stock de l&apos;entrepôt source.
              Cette action ne peut pas être annulée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={isPending}
              onClick={() =>
                run(
                  () => dispatchStockTransferAction({ id: transferId }),
                  "Transfert expédié — stock déduit de la source.",
                  () => setDispatchOpen(false)
                )
              }
            >
              {isPending ? "En cours..." : "Confirmer l'expédition"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <Button type="button" variant="outline" onClick={() => setCancelOpen(true)}>
          <XCircle className="size-4" />
          Annuler
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Annuler ce transfert ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le brouillon sera marqué comme annulé. Aucun stock n&apos;est déplacé.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Retour</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              disabled={isPending}
              onClick={() =>
                run(
                  () => cancelStockTransferAction({ id: transferId }),
                  "Transfert annulé.",
                  () => setCancelOpen(false)
                )
              }
            >
              {isPending ? "En cours..." : "Confirmer l'annulation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
