"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { createShipmentViaProviderAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";

/**
 * "Recréer l'expédition" on a shipment that failed (ECHEC). Re-runs the
 * exact same provider create for the order — a fresh attempt, e.g. after a
 * city correspondence was added. The failed row stays as history.
 */
export function RetryShipmentButton({ orderId, providerId }: { orderId: string; providerId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function retry() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("orderId", orderId);
      fd.set("providerId", providerId);
      const result = await createShipmentViaProviderAction(fd);
      if (result.ok) {
        toast.success("Expédition recréée.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={retry} title="Recréer l'expédition">
      <RotateCcw className={isPending ? "size-4 animate-spin" : "size-4"} />
      Recréer
    </Button>
  );
}
