"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { updateOrderShippingAddressAction } from "@/actions/orders";
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

type Address = {
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
};

export function EditShippingAddressDialog({ orderId, address }: { orderId: string; address: Address }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await updateOrderShippingAddressAction(formData);
      if (result.ok) {
        toast.success("Adresse de livraison mise à jour.");
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
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>
        <Pencil className="size-3.5" />
        Modifier l&apos;adresse
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adresse de livraison</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="id" value={orderId} />
          <div className="space-y-1.5">
            <Label htmlFor="esa-line1">Adresse</Label>
            <Input id="esa-line1" name="shippingAddressLine1" defaultValue={address.shippingAddressLine1 ?? ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="esa-line2">Complément</Label>
            <Input id="esa-line2" name="shippingAddressLine2" defaultValue={address.shippingAddressLine2 ?? ""} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="esa-city">Ville</Label>
              <Input id="esa-city" name="shippingCity" defaultValue={address.shippingCity ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="esa-region">Région</Label>
              <Input id="esa-region" name="shippingRegion" defaultValue={address.shippingRegion ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="esa-country">Pays</Label>
              <Input id="esa-country" name="shippingCountry" defaultValue={address.shippingCountry ?? "Maroc"} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="esa-phone">Téléphone</Label>
              <Input id="esa-phone" name="shippingPhone" defaultValue={address.shippingPhone ?? ""} />
            </div>
          </div>
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <strong>Ville :</strong> écrivez-la exactement comme chez la société de livraison (OzonExpress), sinon le
            colis ne pourra pas être créé.
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
