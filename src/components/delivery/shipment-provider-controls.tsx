"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, XCircle } from "lucide-react";
import { syncShipmentStatusAction, cancelShipmentAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";

const OUTCOME_LABELS: Record<string, string> = {
  updated: "Statut mis à jour.",
  unchanged: "Statut inchangé.",
  unknown_status: "Le transporteur signale un statut non reconnu — voir les notes de l'expédition.",
};

/** Only rendered for shipments created via an API connector (externalId
 * set) — a MANUEL/FLOTTE_INTERNE shipment has nothing to synchronize or
 * cancel through a carrier. See docs/adr/0012-delivery-provider-integration.md. */
export function ShipmentProviderControls({ shipmentId, canCancel }: { shipmentId: string; canCancel: boolean }) {
  const router = useRouter();
  const [isSyncing, startSync] = useTransition();
  const [isCancelling, startCancel] = useTransition();

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

  function cancel() {
    startCancel(async () => {
      const fd = new FormData();
      fd.set("shipmentId", shipmentId);
      const result = await cancelShipmentAction(fd);
      if (result.ok) toast.success("Expédition annulée auprès du transporteur.");
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button type="button" variant="ghost" size="sm" disabled={isSyncing} onClick={sync} title="Synchroniser le statut">
        <RefreshCw className={isSyncing ? "size-4 animate-spin" : "size-4"} />
      </Button>
      {canCancel && (
        <Button type="button" variant="ghost" size="sm" disabled={isCancelling} onClick={cancel} title="Annuler l'expédition">
          <XCircle className="size-4" />
        </Button>
      )}
    </div>
  );
}
