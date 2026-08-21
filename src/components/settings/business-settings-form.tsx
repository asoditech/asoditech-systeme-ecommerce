"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateBusinessSettingsAction } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import type { BusinessSettings } from "@prisma/client";
import type { ActionResult } from "@/actions/types";

export function BusinessSettingsForm({ settings }: { settings: BusinessSettings }) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<BusinessSettings> | undefined, formData: FormData) =>
      updateBusinessSettingsAction(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success("Paramètres enregistrés.");
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
  }, [state, router]);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="companyName">Nom de l&apos;entreprise</Label>
              <Input id="companyName" name="companyName" defaultValue={settings.companyName} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="currency">Devise</Label>
              <Input id="currency" name="currency" maxLength={3} defaultValue={settings.currency} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail de contact</Label>
              <Input id="email" name="email" type="email" defaultValue={settings.email ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Téléphone</Label>
              <Input id="phone" name="phone" defaultValue={settings.phone ?? ""} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="address">Adresse</Label>
              <Input id="address" name="address" defaultValue={settings.address ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city">Ville</Label>
              <Input id="city" name="city" defaultValue={settings.city ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="country">Pays</Label>
              <Input id="country" name="country" defaultValue={settings.country} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Fuseau horaire</Label>
              <Input id="timezone" name="timezone" defaultValue={settings.timezone} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lowStockDefaultThreshold">Seuil de stock faible par défaut</Label>
              <Input
                id="lowStockDefaultThreshold"
                name="lowStockDefaultThreshold"
                type="number"
                min="0"
                defaultValue={settings.lowStockDefaultThreshold}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="orderNumberPrefix">Préfixe des numéros de commande</Label>
              <Input id="orderNumberPrefix" name="orderNumberPrefix" defaultValue={settings.orderNumberPrefix} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
