"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Truck } from "lucide-react";
import { createShipmentAction } from "@/actions/delivery";
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
import type { ShippingProvider } from "@prisma/client";
import type { ActionResult, IdResult } from "@/actions/types";

export function CreateShipmentDialog({ orderId, providers }: { orderId: string; providers: ShippingProvider[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await createShipmentAction(formData);
      if (result.ok) {
        toast.success("Expédition créée.");
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
      <DialogTrigger render={<Button type="button" size="sm" />}>
        <Truck className="size-4" />
        Créer une expédition
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nouvelle expédition</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="orderId" value={orderId} />
          <div className="space-y-1.5">
            <Label htmlFor="providerId">Prestataire</Label>
            <Select name="providerId" required>
              <SelectTrigger id="providerId" className="w-full">
                <SelectValue placeholder="Choisir un prestataire">
                  {(value: string) => providers.find((p) => p.id === value)?.name ?? "Choisir un prestataire"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trackingNumber">Numéro de suivi</Label>
            <Input id="trackingNumber" name="trackingNumber" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="trackingUrl">Lien de suivi</Label>
            <Input id="trackingUrl" name="trackingUrl" type="url" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cost">Coût de livraison (MAD)</Label>
            <Input id="cost" name="cost" type="number" step="0.01" min="0" />
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Création..." : "Créer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
