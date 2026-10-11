"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateShipmentStatusAction } from "@/actions/delivery";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { SHIPMENT_FAILED_REASON_MIN, SHIPMENT_STATUS_TRANSITIONS, type ShipmentStatusValue } from "@/lib/validation/delivery";
import { SHIPMENT_STATUS_LABELS } from "@/lib/status-labels";

/**
 * Manual shipment status change. « Échec » asks for its reason (required
 * server-side too). A parcel registered at a carrier (`carrierParcel`) can't
 * be set « Annulé » here — that must happen at the carrier (the server
 * refuses it as well). A status picked here is only ever a LOCAL update —
 * nothing is sent to the carrier — so the options say so: « mise à jour
 * locale » on a carrier parcel, « local uniquement » on « Annulé » elsewhere.
 */
export function ShipmentStatusSelect({
  shipmentId,
  currentStatus,
  carrierParcel = false,
}: {
  shipmentId: string;
  currentStatus: ShipmentStatusValue;
  carrierParcel?: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(currentStatus);
  const [failureOpen, setFailureOpen] = useState(false);
  const [failedReason, setFailedReason] = useState("");
  const transitions = SHIPMENT_STATUS_TRANSITIONS[currentStatus].filter((s) => !(carrierParcel && s === "ANNULE"));
  const options = [currentStatus, ...transitions];
  const optionHint = (s: ShipmentStatusValue): string =>
    s === currentStatus ? "" : carrierParcel ? " (mise à jour locale)" : s === "ANNULE" ? " (local uniquement)" : "";

  function apply(next: ShipmentStatusValue, reason?: string) {
    setValue(next);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("id", shipmentId);
      formData.set("status", next);
      if (reason) formData.set("failedReason", reason);
      const result = await updateShipmentStatusAction(formData);
      if (result.ok) {
        toast.success("Statut de livraison mis à jour.");
        setFailureOpen(false);
        setFailedReason("");
        router.refresh();
      } else {
        toast.error(result.error);
        setValue(currentStatus);
      }
    });
  }

  const reasonOk = failedReason.trim().length >= SHIPMENT_FAILED_REASON_MIN;

  return (
    <>
      <Select
        value={value}
        disabled={isPending || transitions.length === 0}
        onValueChange={(next) => {
          if (!next || next === currentStatus) return;
          if (next === "ECHEC") {
            setFailureOpen(true);
            return;
          }
          apply(next as ShipmentStatusValue);
        }}
      >
        <SelectTrigger
          className="w-44"
          aria-label="Statut de l'expédition"
          title={carrierParcel ? "Modification locale : le transporteur n'est pas informé." : undefined}
        >
          <SelectValue>{(value: string) => SHIPMENT_STATUS_LABELS[value]?.label ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((s) => (
            <SelectItem key={s} value={s}>
              {SHIPMENT_STATUS_LABELS[s].label}
              {optionHint(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <AlertDialog open={failureOpen} onOpenChange={(o) => !isPending && setFailureOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Marquer la livraison en échec</AlertDialogTitle>
            <AlertDialogDescription>
              La raison est affichée sur l&apos;expédition et envoyée dans la notification d&apos;échec. Le statut de la
              commande ne change pas : vous pourrez la ré-expédier ou la traiter manuellement.
              {carrierParcel && " Mise à jour locale uniquement : le transporteur n'est pas informé."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`failed-reason-${shipmentId}`}>Raison de l&apos;échec (obligatoire)</Label>
            <Textarea
              id={`failed-reason-${shipmentId}`}
              value={failedReason}
              maxLength={1000}
              placeholder="Ex. : client injoignable, adresse introuvable…"
              onChange={(e) => setFailedReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={isPending}>
              Retour
            </AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={!reasonOk || isPending}
              onClick={() => apply("ECHEC", failedReason.trim())}
            >
              {isPending ? "Enregistrement…" : "Marquer en échec"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
