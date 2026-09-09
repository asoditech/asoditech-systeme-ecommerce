"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { reopenOrderAction } from "@/actions/orders";
import { Button } from "@/components/ui/button";

/**
 * "Undo a wrong cancellation" — moves an ANNULEE order (never shipped)
 * back to NOUVELLE so it re-enters the confirmation queue. See ADR 0030.
 */
export function ReopenOrderButton({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function reopen() {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("id", orderId);
      const res = await reopenOrderAction(fd);
      if (res.ok) {
        toast.success("Commande rétablie — de retour dans la file de confirmation.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Button type="button" variant="outline" disabled={isPending} onClick={reopen}>
      <RotateCcw className="size-4" />
      {isPending ? "En cours..." : "Rétablir la commande"}
    </Button>
  );
}
