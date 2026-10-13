"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { syncConnectedOrdersAction, syncConnectedProductsAction } from "@/actions/sync";
import { Button } from "@/components/ui/button";
import { runSyncLoop } from "@/lib/integrations/shared/sync-loop";

function describe(totals: ReadonlyMap<string, { imported: number; updated: number; skipped: number; failed: number }>): string {
  return [...totals.entries()]
    .map(
      ([platform, t]) =>
        `${platform} : ${t.imported} importée(s), ${t.updated} mise(s) à jour` +
        (t.skipped > 0 ? `, ${t.skipped} ignorée(s)` : "") +
        (t.failed > 0 ? `, ${t.failed} en échec` : "")
    )
    .join(" · ");
}

/**
 * « Synchroniser » / « Actualiser » — on the Commandes / Produits / Stock
 * pages. When the current user can sync (`canSync`, i.e. has
 * `integrations.manage` and a store is connected), one click pulls the
 * latest from WooCommerce / Shopify and then reloads the page. Otherwise
 * it is a plain page refresh so a confirmateur / warehouse user can still
 * pick up webhook-imported changes without a hard reload.
 *
 * Each server call is capped (a few new orders per run); this button keeps
 * calling while a platform reports `hasMore` (runSyncLoop), showing the
 * running totals, so one click imports the whole backlog — before
 * 2026-10-12 it stopped after the first 15 new orders.
 */
export function SyncRefreshButton({
  resource,
  canSync,
  size = "sm",
}: {
  resource: "orders" | "products";
  canSync: boolean;
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      if (canSync) {
        const action = resource === "orders" ? syncConnectedOrdersAction : syncConnectedProductsAction;
        const toastId = `sync-${resource}`;
        // Totals per platform across every capped run of this one click.
        const totals = new Map<string, { imported: number; updated: number; skipped: number; failed: number; notes: string[] }>();
        const errors: string[] = [];
        let pending: string[] | undefined;
        toast.loading("Synchronisation…", { id: toastId });
        try {
          const outcome = await runSyncLoop(
            () => action(pending),
            (data) => data.ran.some((r) => r.hasMore),
            (data) => {
              for (const r of data.ran) {
                const t = totals.get(r.platform) ?? { imported: 0, updated: 0, skipped: 0, failed: 0, notes: [] };
                t.imported += r.imported;
                t.updated += r.updated;
                t.skipped += r.skipped;
                t.failed += r.failed;
                for (const n of r.notes) if (!t.notes.includes(n) && !n.startsWith("Lot traité")) t.notes.push(n);
                totals.set(r.platform, t);
              }
              errors.push(...data.errors);
              pending = data.ran.filter((r) => r.hasMore).map((r) => r.platform);
              if (pending.length > 0) toast.loading(`Synchronisation en cours… ${describe(totals)}`, { id: toastId });
            }
          );
          if (!outcome.ok) {
            toast.error(totals.size > 0 ? `${outcome.error} (déjà traité : ${describe(totals)})` : outcome.error, { id: toastId });
          } else {
            const notes = [...totals.values()].flatMap((t) => t.notes).slice(0, 2);
            const text = [describe(totals) || "Synchronisation terminée.", ...errors, ...notes].join(" · ");
            const failed = errors.length > 0 || [...totals.values()].some((t) => t.failed > 0);
            const suffix = outcome.stoppedAtCap ? " — il en reste : relancez la synchronisation." : "";
            if (failed) toast.warning(text + suffix, { id: toastId });
            else toast.success(text + suffix, { id: toastId });
          }
        } catch {
          toast.error("La synchronisation a échoué ou expiré. Réessayez.", { id: toastId });
        }
      }
      router.refresh();
    });
  }

  return (
    <Button type="button" variant="outline" size={size} disabled={isPending} onClick={onClick}>
      <RefreshCw className={isPending ? "size-4 animate-spin" : "size-4"} />
      {canSync ? (isPending ? "Synchronisation…" : "Synchroniser") : isPending ? "Actualisation…" : "Actualiser"}
    </Button>
  );
}
