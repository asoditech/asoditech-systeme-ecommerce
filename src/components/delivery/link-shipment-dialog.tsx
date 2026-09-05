"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { linkExistingShipmentAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ShipmentProviderOption } from "@/components/delivery/create-shipment-dialog";
import type { ActionResult, IdResult } from "@/actions/types";

/**
 * Attach a parcel already created in the carrier's own portal / by the
 * storefront plugin to this order, and pull its status. Only lists API
 * providers that are connected — a manual tracking number for a non-API
 * provider is what "Créer une expédition" is for.
 */
export function LinkShipmentDialog({
  orderId,
  providers,
  defaultNotes,
}: {
  orderId: string;
  providers: ShipmentProviderOption[];
  defaultNotes?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const apiProviders = providers.filter((p) => p.type === "API" && p.connectionStatus === "CONNECTE");

  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await linkExistingShipmentAction(formData);
      if (result.ok) {
        toast.success("Colis lié — statut récupéré depuis le transporteur.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  if (apiProviders.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
        <Link2 className="size-4" />
        Lier un colis existant
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Lier un colis déjà créé chez le transporteur</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="orderId" value={orderId} />
          <p className="text-sm text-muted-foreground">
            Pour un colis créé dans le portail du transporteur (ou par la boutique). Saisissez son numéro de suivi :
            l&apos;expédition est créée ici et son statut récupéré immédiatement.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="link-providerId">Prestataire</Label>
            <Select name="providerId" required defaultValue={apiProviders.length === 1 ? apiProviders[0].id : undefined}>
              <SelectTrigger id="link-providerId" className="w-full">
                <SelectValue placeholder="Choisir un prestataire">
                  {(value: string) => apiProviders.find((p) => p.id === value)?.name ?? "Choisir un prestataire"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {apiProviders.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-trackingNumber">Numéro de suivi</Label>
            <Input id="link-trackingNumber" name="trackingNumber" required placeholder="ex. OZE123456 ou WEB988442" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="link-notes">Notes</Label>
            <Input id="link-notes" name="notes" defaultValue={defaultNotes} />
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Liaison..." : "Lier et récupérer le statut"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
