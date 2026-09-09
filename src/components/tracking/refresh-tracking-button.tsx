"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { refreshTrackingAction, refreshTrackingBatchAction } from "@/actions/tracking";
import { Button } from "@/components/ui/button";

/**
 * « Suivi » refresh controls (docs/adr/0033).
 *
 * - `mode="single"` refreshes one shipment.
 * - `mode="batch"` loops the bounded bulk action until every open API
 *   shipment has been polled, then refreshes the page. A hard round cap
 *   keeps a persistently-failing carrier from spinning forever, matching
 *   `RefreshStatusesButton`.
 *
 * Neither path can overwrite a valid last-known status with "inconnu" — the
 * server service keeps the previous status/events on any carrier error.
 */
const MAX_ROUNDS = 40;

export function RefreshTrackingButton({
  mode,
  shipmentId,
  size = "sm",
  variant = "outline",
  label,
}: {
  mode: "single" | "batch";
  shipmentId?: string;
  size?: "sm" | "default";
  variant?: "outline" | "ghost" | "default";
  label?: string;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);

  async function runSingle() {
    if (!shipmentId) return;
    const res = await refreshTrackingAction(formDataOf({ shipmentId }));
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(
      res.data.eventsFetched
        ? `Suivi actualisé — ${res.data.eventCount} évènement(s).`
        : "Statut actualisé (le transporteur ne fournit pas d'historique détaillé)."
    );
    router.refresh();
  }

  async function runBatch() {
    let checked = 0;
    let withEvents = 0;
    let failed = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await refreshTrackingBatchAction();
      if (!res.ok) {
        toast.error(res.error);
        break;
      }
      checked += res.data.checked;
      withEvents += res.data.withEvents;
      failed += res.data.failed;
      if (!res.data.hasMore || res.data.checked === 0) break;
    }
    if (checked === 0) {
      toast.info("Aucune expédition ouverte à actualiser.");
    } else {
      toast.success(
        `${checked} expédition(s) vérifiée(s) — ${withEvents} avec historique${failed > 0 ? `, ${failed} en erreur` : ""}.`
      );
    }
    router.refresh();
  }

  async function run() {
    if (running) return;
    setRunning(true);
    try {
      if (mode === "single") await runSingle();
      else await runBatch();
    } finally {
      setRunning(false);
    }
  }

  const defaultLabel = mode === "single" ? "Actualiser" : "Actualiser le suivi";

  return (
    <Button type="button" variant={variant} size={size} disabled={running} onClick={run}>
      <RefreshCw className={running ? "size-4 animate-spin" : "size-4"} />
      {running ? "Actualisation…" : (label ?? defaultLabel)}
    </Button>
  );
}

function formDataOf(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
