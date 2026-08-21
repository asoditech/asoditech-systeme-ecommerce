"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { createCustomerAddressAction } from "@/actions/customers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Plus } from "lucide-react";
import type { CustomerAddress } from "@prisma/client";
import type { ActionResult } from "@/actions/types";

export function CustomerAddressForm({ customerId }: { customerId: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<CustomerAddress> | undefined, formData: FormData) => {
      const result = await createCustomerAddressAction(formData);
      if (result.ok) {
        toast.success("Adresse ajoutée.");
        setOpen(false);
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Ajouter une adresse
      </Button>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4" key={state?.ok ? "reset" : "form"}>
          <input type="hidden" name="customerId" value={customerId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="label">Libellé</Label>
              <Input id="label" name="label" placeholder="Domicile, Bureau..." />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Téléphone</Label>
              <Input id="phone" name="phone" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="addressLine1">Adresse</Label>
              <Input id="addressLine1" name="addressLine1" required />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="addressLine2">Complément d&apos;adresse</Label>
              <Input id="addressLine2" name="addressLine2" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city">Ville</Label>
              <Input id="city" name="city" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="region">Région</Label>
              <Input id="region" name="region" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="country">Pays</Label>
              <Input id="country" name="country" defaultValue="Maroc" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="isDefault" name="isDefault" />
            <Label htmlFor="isDefault" className="font-normal">
              Adresse par défaut
            </Label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Ajout..." : "Ajouter l'adresse"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
