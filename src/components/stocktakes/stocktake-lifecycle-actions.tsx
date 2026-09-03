"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, XCircle } from "lucide-react";
import { finalizeStocktakeSessionAction, cancelStocktakeSessionAction } from "@/actions/stocktakes";
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

export function StocktakeLifecycleActions({
  sessionId,
  countedLines,
}: {
  sessionId: string;
  countedLines: number;
}) {
  const router = useRouter();
  const [finalizeOpen, setFinalizeOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  function finalize() {
    startTransition(async () => {
      const result = await finalizeStocktakeSessionAction({ id: sessionId });
      if (result.ok) {
        toast.success(
          `Inventaire clôturé — ${result.data.applied} ajustement(s), ${result.data.zeroVariance} sans écart, ${result.data.uncounted} non compté(s).`
        );
        setFinalizeOpen(false);
        router.refresh();
      } else {
        // Stale-line rejection lands here: the session stays EN_COURS and
        // the refreshed detail shows the "Périmée" badges.
        toast.error(result.error);
        setFinalizeOpen(false);
        router.refresh();
      }
    });
  }

  function cancel() {
    startTransition(async () => {
      const result = await cancelStocktakeSessionAction({ id: sessionId });
      if (result.ok) {
        toast.success("Inventaire annulé.");
        setCancelOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <AlertDialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
        <Button type="button" onClick={() => setFinalizeOpen(true)}>
          <CheckCircle2 className="size-4" />
          Clôturer
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clôturer cet inventaire ?</AlertDialogTitle>
            <AlertDialogDescription>
              L&apos;écart de chaque ligne comptée ({countedLines} ligne(s)) sera appliqué au stock via un
              mouvement d&apos;inventaire. Les lignes non comptées sont ignorées. Si le stock d&apos;une ligne a
              changé depuis le comptage, la clôture est refusée et la ligne doit être recomptée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={finalize} disabled={isPending}>
              {isPending ? "En cours..." : "Confirmer la clôture"}
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
            <AlertDialogTitle>Annuler cet inventaire ?</AlertDialogTitle>
            <AlertDialogDescription>
              La session sera marquée comme annulée. Aucun stock n&apos;est modifié et les comptages saisis sont
              conservés pour référence.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Retour</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={cancel} disabled={isPending}>
              {isPending ? "En cours..." : "Confirmer l'annulation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
