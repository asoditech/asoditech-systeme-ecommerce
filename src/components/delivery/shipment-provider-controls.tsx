"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Tag } from "lucide-react";
import { syncShipmentStatusAction, cancelShipmentAction, getShipmentLabelAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { ConfirmActionButton } from "@/components/confirm-action-button";

const OUTCOME_LABELS: Record<string, string> = {
  updated: "Statut mis à jour.",
  unchanged: "Statut inchangé.",
  unknown_status: "Le transporteur signale un statut non reconnu — voir les notes de l'expédition.",
};

/** Only rendered for shipments created via an API connector (externalId
 * set) — a MANUEL/FLOTTE_INTERNE shipment has nothing to synchronize or
 * cancel through a carrier. See docs/adr/0012-delivery-provider-integration.md.
 * `canCancel` comes from canCancelCarrierShipment (connector capability +
 * a local status that still allows « Annulé »). */
export function ShipmentProviderControls({
  shipmentId,
  providerName,
  canCancel,
  canFetchLabel = false,
}: {
  shipmentId: string;
  providerName: string;
  canCancel: boolean;
  /** Connector declares FETCH_LABEL (docs/adr/0060). */
  canFetchLabel?: boolean;
}) {
  const router = useRouter();
  const [isSyncing, startSync] = useTransition();
  const [isLabelLoading, startLabel] = useTransition();

  function openLabel() {
    // Open the tab synchronously (popup blockers), then point it at the
    // signed link once the carrier returns it; the link is never stored.
    const tab = window.open("about:blank", "_blank");
    startLabel(async () => {
      const fd = new FormData();
      fd.set("shipmentId", shipmentId);
      const result = await getShipmentLabelAction(fd);
      if (result.ok && tab) tab.location.href = result.data.url;
      else {
        tab?.close();
        if (!result.ok) toast.error(result.error);
      }
    });
  }

  function sync() {
    startSync(async () => {
      const fd = new FormData();
      fd.set("shipmentId", shipmentId);
      const result = await syncShipmentStatusAction(fd);
      if (result.ok) toast.success(OUTCOME_LABELS[result.data.outcome] ?? "Synchronisé.");
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button type="button" variant="ghost" size="sm" disabled={isSyncing} onClick={sync} title="Synchroniser le statut">
        <RefreshCw className={isSyncing ? "size-4 animate-spin" : "size-4"} />
      </Button>
      {canFetchLabel && (
        <Button type="button" variant="ghost" size="sm" disabled={isLabelLoading} onClick={openLabel} title="Imprimer l'étiquette du colis">
          <Tag className="size-4" />
          Étiquette
        </Button>
      )}
      {canCancel && (
        <ConfirmActionButton
          label="Annuler"
          variant="ghost"
          title="Annuler ce colis chez le transporteur ?"
          description={`L'annulation est envoyée à ${providerName} : le colis y sera annulé, puis l'expédition passera « Annulé » ici. Cette action est irréversible.`}
          hiddenFields={{ shipmentId }}
          action={cancelShipmentAction}
          successMessage="Expédition annulée auprès du transporteur."
          destructive
        />
      )}
    </div>
  );
}
