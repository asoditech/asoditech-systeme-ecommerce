import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format";
import { SYNC_RUN_STATUS_LABELS } from "@/lib/status-labels";
import type { SyncRun } from "@prisma/client";

const DOT_TONE: Record<"default" | "secondary" | "destructive" | "outline", string> = {
  default: "bg-emerald-500",
  secondary: "bg-muted-foreground/40",
  destructive: "bg-destructive",
  outline: "bg-amber-500",
};

function summaryLine(run: SyncRun): string {
  const parts = [
    run.itemsImported > 0 && `${run.itemsImported} importé(s)`,
    run.itemsUpdated > 0 && `${run.itemsUpdated} mis à jour`,
    run.itemsUnchanged > 0 && `${run.itemsUnchanged} inchangé(s)`,
    run.itemsSkipped > 0 && `${run.itemsSkipped} ignoré(s)`,
    run.itemsFailed > 0 && `${run.itemsFailed} échoué(s)`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "aucun élément traité";
}

/**
 * One WooCommerce/Shopify sync resource line (Catégories, Produits,
 * Commandes, Stock) — shared so the two provider cards can't visually
 * diverge. A small colored dot (reusing SYNC_RUN_STATUS_LABELS' Badge
 * `variant` as the color source, never a separate status vocabulary)
 * reads faster at a glance than a full pill badge repeated four times.
 */
export function SyncResourceRow({
  icon: Icon,
  label,
  direction,
  run,
}: {
  icon: LucideIcon;
  label: string;
  direction: string;
  run: SyncRun | undefined;
}) {
  const meta = run ? SYNC_RUN_STATUS_LABELS[run.status] : undefined;
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-[13px] leading-snug font-medium text-foreground">{label}</p>
          <p className="truncate text-[11px] text-muted-foreground">{direction}</p>
        </div>
      </div>
      {run && meta ? (
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right text-xs" title={summaryLine(run)}>
          <span className="flex items-center gap-1.5 text-foreground/80">
            <span className={cn("size-1.5 rounded-full", DOT_TONE[meta.variant])} aria-hidden="true" />
            {meta.label}
          </span>
          <span className="text-[11px] text-muted-foreground">{formatDateTime(run.startedAt)}</span>
        </div>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground/70">Jamais synchronisé</span>
      )}
    </div>
  );
}
