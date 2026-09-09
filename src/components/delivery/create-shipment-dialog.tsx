"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Truck } from "lucide-react";
import { createShipmentAction, createShipmentViaProviderAction } from "@/actions/delivery";
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
import { EditShippingAddressDialog } from "@/components/orders/edit-shipping-address-dialog";
import { CityMappingDialog } from "@/components/delivery/city-mapping-dialog";
import type { ShippingProviderType, IntegrationStatus } from "@prisma/client";
import type { ActionResult, IdResult } from "@/actions/types";

export type OrderShippingAddress = {
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
};

/** True when the error is something the operator can fix on the spot —
 * an incomplete address, or a city the carrier doesn't recognise. */
function isFixableAddressError(message: string): boolean {
  return /adresse de livraison|ville|city/i.test(message);
}

/**
 * Deliberately narrow — never the full ShippingProvider row. That row
 * carries credentialsEncrypted (ciphertext, but still meant to never leave
 * the server — see docs/adr/0004-integration-architecture.md's identical
 * rule for Integration) and raw adapter `config`. This is a Client
 * Component, so whatever shape its props take is serialized into the RSC
 * payload sent to the browser — passing the full row here would put that
 * ciphertext on the wire for no reason. Phase 30 hardening.
 */
export interface ShipmentProviderOption {
  id: string;
  name: string;
  type: ShippingProviderType;
  connectionStatus: IntegrationStatus | null;
}

export function CreateShipmentDialog({
  orderId,
  providers,
  defaultNotes,
  orderAddress,
}: {
  orderId: string;
  providers: ShipmentProviderOption[];
  defaultNotes?: string;
  orderAddress?: OrderShippingAddress;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<string | undefined>(undefined);
  const selectedProvider = providers.find((p) => p.id === providerId);
  const isApiProvider = selectedProvider?.type === "API";
  const apiProviderReady = isApiProvider && selectedProvider?.connectionStatus === "CONNECTE";

  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const useProviderApi = providers.find((p) => p.id === formData.get("providerId"))?.type === "API";
      const result = useProviderApi ? await createShipmentViaProviderAction(formData) : await createShipmentAction(formData);
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
            <Select name="providerId" required onValueChange={(value) => setProviderId((value as string | null) ?? undefined)}>
              <SelectTrigger id="providerId" className="w-full">
                <SelectValue placeholder="Choisir un prestataire">
                  {(value: string) => providers.find((p) => p.id === value)?.name ?? "Choisir un prestataire"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                    {p.type === "API" ? ` (connecteur API)` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isApiProvider ? (
            <>
              {!apiProviderReady && (
                <p className="text-sm text-destructive">
                  Ce prestataire n&apos;est pas encore connecté. Configurez-le et testez la connexion depuis l&apos;onglet
                  Prestataires avant de créer une expédition.
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Le numéro de suivi, le lien de suivi et le coût seront renseignés automatiquement par le connecteur.
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="notes">Notes</Label>
                <Input id="notes" name="notes" defaultValue={defaultNotes} />
                <p className="text-xs text-muted-foreground">Pré-rempli avec les produits de la commande — modifiable.</p>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}

          {state && !state.ok && (
            <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-sm text-destructive">{state.error}</p>
              {isFixableAddressError(state.error) && (
                <div className="flex flex-wrap gap-2">
                  {orderAddress && <EditShippingAddressDialog orderId={orderId} address={orderAddress} />}
                  {selectedProvider?.type === "API" && (
                    <CityMappingDialog
                      providerId={selectedProvider.id}
                      providerName={selectedProvider.name}
                      defaultLocalCity={orderAddress?.shippingCity ?? undefined}
                      triggerLabel="Corriger la ville"
                      triggerVariant="outline"
                    />
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="submit" disabled={isPending || (isApiProvider && !apiProviderReady)}>
              {isPending ? "Création..." : state && !state.ok ? "Réessayer" : "Créer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
