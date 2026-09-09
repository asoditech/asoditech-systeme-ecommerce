"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Coins } from "lucide-react";
import { updateShippingProviderPricingAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * « Tarification » — the merchant's cost rules for NON-successful delivery
 * outcomes (docs/adr/0032). A successful delivery's price is ALWAYS the
 * carrier's own (for an API provider) — it is never entered here.
 */
export function ProviderPricingDialog({
  providerId,
  providerName,
  isApiProvider,
  returnCost,
  failureCost,
}: {
  providerId: string;
  providerName: string;
  isApiProvider: boolean;
  returnCost: string | null;
  failureCost: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await updateShippingProviderPricingAction(formData);
      if (result.ok) {
        toast.success("Tarification enregistrée.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" size="sm" variant="ghost" />}>
        <Coins className="size-4" />
        Tarification
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tarification — {providerName}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="id" value={providerId} />

          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">Livraison réussie</p>
            <p className="text-muted-foreground">
              {isApiProvider
                ? "Calculée par l'API du transporteur — origine + destination. Non modifiable ici : le transporteur est la source de vérité."
                : "Saisie sur chaque expédition (ce prestataire n'a pas d'API de tarification)."}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pp-return">Retour (MAD)</Label>
              <Input
                id="pp-return"
                name="returnCost"
                type="number"
                step="0.01"
                min="0"
                defaultValue={returnCost ?? ""}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">Colis retourné / refusé / non reçu.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pp-failure">Échec de livraison (MAD)</Label>
              <Input
                id="pp-failure"
                name="failureCost"
                type="number"
                step="0.01"
                min="0"
                defaultValue={failureCost ?? ""}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">Échec sans retour facturé / annulation.</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Vide = 0 MAD. Ces montants ne sont pas « le coût de livraison » ni un pourcentage de celui-ci — ils sont
            appliqués uniquement aux issues non réussies. Les expéditions déjà terminées ne changent pas.
          </p>

          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
