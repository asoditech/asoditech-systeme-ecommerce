import { cn } from "@/lib/utils";
import { INTEGRATION_STATUS_LABELS } from "@/lib/status-labels";
import type { IntegrationStatus } from "@prisma/client";

const DOT_TONE: Record<IntegrationStatus, string> = {
  DECONNECTE: "bg-muted-foreground/40",
  CONFIGURE: "bg-amber-500",
  CONNECTE: "bg-emerald-500",
  ERREUR: "bg-destructive",
};

const TEXT_TONE: Record<IntegrationStatus, string> = {
  DECONNECTE: "text-muted-foreground",
  CONFIGURE: "text-amber-700 dark:text-amber-400",
  CONNECTE: "text-emerald-700 dark:text-emerald-400",
  ERREUR: "text-destructive",
};

/**
 * A connection-status chip — a colored dot (pulsing while genuinely
 * connected) + label, the same "at a glance" idiom as SyncResourceRow's
 * dots. Reuses INTEGRATION_STATUS_LABELS as the single source of truth
 * for wording; only the visual treatment (dot instead of a filled Badge)
 * differs from the rest of the app's status badges, deliberately — a
 * provider card's own identity color (its icon avatar) already carries
 * the "brand" weight, so the status reads as secondary information here.
 */
export function ConnectionStatusPill({ status }: { status: IntegrationStatus }) {
  const label = INTEGRATION_STATUS_LABELS[status]?.label ?? status;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TEXT_TONE[status])}>
      <span className="relative flex size-1.5">
        {status === "CONNECTE" && (
          <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOT_TONE[status])} />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", DOT_TONE[status])} />
      </span>
      {label}
    </span>
  );
}
