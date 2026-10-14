"use client";

import { startTransition, useActionState, useRef, useState } from "react";
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
import { ShipmentConfirmationSummary } from "@/components/delivery/shipment-confirmation-summary";
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
import { createConfirmGate } from "@/lib/shipment-confirmation";
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
 * an incomplete address, a city the carrier doesn't recognise, or a
 * badly-formatted phone number. */
function isFixableAddressError(message: string): boolean {
  return /adresse de livraison|ville|city|phone|téléphone|numéro/i.test(message);
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
  /** Adapter-reported capabilities (e.g. `FETCH_CITIES`, `CANCEL_SHIPMENT`)
   * — used to show only the affordances this provider instance genuinely
   * supports instead of assuming every API provider is the same (Batch 18). */
  capabilities: string[];
}

/** What the confirmation step shows about the order (carrier comes from the selection). */
export interface ShipmentOrderSummary {
  recipientName: string;
  city: string | null;
  /** null = prepaid, nothing to collect (same rule as the server's `codAmount`). */
  codAmount: number | null;
  currency: string;
  lineCount: number;
}

export function CreateShipmentDialog({
  orderId,
  providers,
  defaultNotes,
  orderAddress,
  orderSummary,
}: {
  orderId: string;
  providers: ShipmentProviderOption[];
  defaultNotes?: string;
  orderAddress?: OrderShippingAddress;
  orderSummary?: ShipmentOrderSummary;
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

  // A carrier (API) shipment is confirmed first: submitting the form only
  // stages it; nothing reaches the server — hence no carrier call — until
  // « Confirmer la création ». A manual provider records a local row only.
  const gate = useRef(createConfirmGate<FormData>()).current;
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!isApiProvider) return; // native form action, unchanged
    event.preventDefault();
    if (isPending || !apiProviderReady) return;
    gate.request(new FormData(event.currentTarget));
    setConfirmOpen(true);
  }
  function confirmCreation() {
    setConfirmOpen(false);
    gate.confirm((formData) => startTransition(() => formAction(formData)));
  }
  function cancelCreation() {
    gate.cancel();
    setConfirmOpen(false);
  }

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
        <form action={formAction} onSubmit={handleSubmit} className="space-y-4">
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
            <div className="space-y-2 rounded-tile bg-danger-soft p-3">
              <p className="text-sm text-destructive">{state.error}</p>
              {isFixableAddressError(state.error) && (
                <div className="flex flex-wrap gap-2">
                  {orderAddress && <EditShippingAddressDialog orderId={orderId} address={orderAddress} />}
                  {selectedProvider?.type === "API" && selectedProvider.capabilities.includes("FETCH_CITIES") && (
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
        <AlertDialog open={confirmOpen} onOpenChange={(next) => (next ? setConfirmOpen(true) : cancelCreation())}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Créer le colis chez {selectedProvider?.name ?? "le transporteur"} ?</AlertDialogTitle>
              <AlertDialogDescription>
                Le colis sera enregistré immédiatement chez le transporteur. Vérifiez ces informations avant de confirmer.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ShipmentConfirmationSummary
              rows={[
                { label: "Transporteur", value: selectedProvider?.name ?? "—" },
                ...(orderSummary
                  ? [
                      { label: "Destinataire", value: orderSummary.recipientName },
                      { label: "Ville", value: orderSummary.city ?? "—" },
                      { label: "Montant à encaisser (COD)", money: { amount: orderSummary.codAmount, currency: orderSummary.currency } },
                      { label: "Lignes de commande", value: String(orderSummary.lineCount) },
                    ]
                  : []),
              ]}
            />
            <AlertDialogFooter>
              <AlertDialogCancel type="button" onClick={cancelCreation}>
                Annuler
              </AlertDialogCancel>
              <AlertDialogAction type="button" disabled={isPending} onClick={confirmCreation}>
                Confirmer la création
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
