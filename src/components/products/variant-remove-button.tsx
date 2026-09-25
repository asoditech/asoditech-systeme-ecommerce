"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { removeVariationAction } from "@/actions/products";
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
 * Batch 4, Task 4/11 — "remove from the combination set" without silently
 * destroying history. The action itself decides delete-vs-deactivate
 * (`removeVariationAction`'s own doc comment); this button only confirms
 * the intent and reports back which one happened.
 */
export function VariantRemoveButton({ variationId, label }: { variationId: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", variationId);
      const result = await removeVariationAction(fd);
      if (result.ok) {
        toast.success(result.data.deleted ? "Variation supprimée." : "Variation désactivée (historique conservé).");
        router.refresh();
      } else {
        toast.error(result.error);
      }
      setOpen(false);
    });
  }

  return (
    <>
      <Button type="button" size="icon" variant="ghost" aria-label={`Retirer ${label}`} onClick={() => setOpen(true)}>
        <Trash2 className="size-4" />
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retirer cette variation ?</AlertDialogTitle>
            <AlertDialogDescription>
              {label} sera supprimée si elle n&apos;a jamais été utilisée (aucune commande, vente ou mouvement de
              stock) ; sinon elle sera désactivée — son historique reste visible, elle n&apos;est simplement plus
              proposée pour une nouvelle vente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
            <AlertDialogAction type="button" onClick={confirm} disabled={isPending}>
              {isPending ? "En cours..." : "Confirmer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
