"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { refreshShipmentStatusesAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";

/**
 * "Rafraîchir les statuts" — loops the bounded bulk action until the
 * carrier has been polled for every open shipment, then refreshes the
 * page. A hard iteration cap keeps a persistently-failing carrier from
 * spinning forever.
 */
const MAX_ROUNDS = 40;

export function RefreshStatusesButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);

  async function run() {
    if (running) return;
    setRunning(true);
    let updated = 0;
    let checked = 0;
    let failed = 0;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await refreshShipmentStatusesAction();
        if (!res.ok) {
          toast.error(res.error);
          break;
        }
        checked += res.data.checked;
        updated += res.data.updated;
        failed += res.data.failed;
        if (!res.data.hasMore || res.data.checked === 0) break;
      }
      if (checked === 0) {
        toast.info("Aucune expédition ouverte à rafraîchir.");
      } else {
        toast.success(
          `${checked} expédition(s) vérifiée(s) — ${updated} mise(s) à jour${failed > 0 ? `, ${failed} en erreur` : ""}.`
        );
      }
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={running} onClick={run}>
      <RefreshCw className={running ? "size-4 animate-spin" : "size-4"} />
      {running ? "Rafraîchissement…" : "Rafraîchir les statuts"}
    </Button>
  );
}
