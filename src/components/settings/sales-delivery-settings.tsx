"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BadgePercent, Truck } from "lucide-react";
import { updateDefaultShippingProviderAction, updateSellerPriceOverrideAction } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { NativeSelect } from "@/components/ui/native-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BusinessSettings } from "@prisma/client";
import type { ActionResult } from "@/actions/types";

function useSettingsAction(action: (fd: FormData) => Promise<ActionResult<BusinessSettings>>, success: string) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<BusinessSettings> | undefined, formData: FormData) => action(formData),
    undefined
  );
  useEffect(() => {
    if (state?.ok) {
      toast.success(success);
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
  }, [state, router, success]);
  return { formAction, isPending };
}

const iconBox = "flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground";

/**
 * « Autoriser les vendeurs magasin à modifier le prix » — company-wide.
 * Enforced on the server through effective access (`sales.override_price`);
 * a per-user DENY set in Utilisateurs still wins.
 */
export function SellerPriceOverrideForm({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const { formAction, isPending } = useSettingsAction(updateSellerPriceOverrideAction, "Réglage des prix en magasin enregistré.");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className={iconBox}>
            <BadgePercent className="size-4" />
          </span>
          Ventes en magasin
        </CardTitle>
        <CardDescription>
          Par défaut, seul un responsable (ou un vendeur ayant le droit « modifier le prix ») peut changer le prix
          ou accorder une remise à la caisse.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <input type="hidden" name="allowSellerPriceOverride" value={on ? "true" : "false"} />
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/70 px-3 py-2.5">
            <div>
              <Label htmlFor="allowSellerPriceOverride">Autoriser les vendeurs magasin à modifier le prix</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Activé : tout vendeur qui peut vendre en magasin peut modifier le prix ou la remise d&apos;une vente.
                Un vendeur à qui ce droit est retiré dans Utilisateurs ne le reçoit pas.
              </p>
            </div>
            <Switch id="allowSellerPriceOverride" checked={on} onCheckedChange={(v) => setOn(v === true)} />
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

/**
 * « Transporteur par défaut » — only decides whose city list is suggested on
 * the online order/customer forms when several delivery companies are active.
 */
export function DefaultShippingProviderForm({
  providers,
  defaultProviderId,
}: {
  providers: { id: string; name: string; hasCityList: boolean }[];
  defaultProviderId: string | null;
}) {
  const [value, setValue] = useState(defaultProviderId ?? "");
  const { formAction, isPending } = useSettingsAction(updateDefaultShippingProviderAction, "Transporteur par défaut enregistré.");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className={iconBox}>
            <Truck className="size-4" />
          </span>
          Livraison
        </CardTitle>
        <CardDescription>
          Sert uniquement à proposer la liste des villes du transporteur lors de la saisie d&apos;une commande ou
          d&apos;un client en ligne. Le transporteur réel reste choisi à la création de l&apos;expédition.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="defaultShippingProviderId">Transporteur par défaut</Label>
            <NativeSelect
              id="defaultShippingProviderId"
              name="defaultShippingProviderId"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full sm:w-80"
            >
              <option value="">Aucun (saisie libre de la ville)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.hasCityList ? "" : " — sans liste de villes"}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              {providers.length === 0
                ? "Aucun transporteur actif : la ville est saisie librement."
                : providers.length === 1
                  ? "Un seul transporteur actif : sa liste de villes est utilisée automatiquement."
                  : "Plusieurs transporteurs actifs : sans transporteur par défaut, la ville est saisie librement."}
            </p>
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
