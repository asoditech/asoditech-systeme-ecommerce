import { Badge } from "@/components/ui/badge";
import {
  NORMALIZED_TRACKING_LABELS,
  NORMALIZED_TRACKING_VARIANT,
  type NormalizedTrackingStatus,
} from "@/lib/tracking/status";

/**
 * Renders a normalized « Suivi » status. The carrier's own raw wording is
 * kept and shown as a sub-line — it is never discarded or overwritten.
 */
export function TrackingStatusBadge({
  status,
  raw,
  showRaw = false,
}: {
  status: NormalizedTrackingStatus;
  raw?: string | null;
  showRaw?: boolean;
}) {
  return (
    <span className="inline-flex flex-col gap-0.5">
      <Badge variant={NORMALIZED_TRACKING_VARIANT[status]}>{NORMALIZED_TRACKING_LABELS[status]}</Badge>
      {showRaw && raw ? (
        <span className="text-[11px] text-muted-foreground/70">{raw}</span>
      ) : null}
    </span>
  );
}
