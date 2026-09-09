import { formatDateTime } from "@/lib/format";
import { NORMALIZED_TRACKING_LABELS } from "@/lib/tracking/status";
import type { StoredTrackingEvent } from "@/lib/integrations/delivery/tracking-service";

/**
 * Carrier tracking history, newest first. Purely a render of persisted
 * `Shipment.trackingEvents` — no live call, nothing fabricated. When the
 * carrier provides no history the caller shows an explanatory empty state
 * instead of this.
 */
export function TrackingTimeline({ events }: { events: StoredTrackingEvent[] }) {
  const ordered = [...events].reverse();
  return (
    <ol className="relative space-y-4 border-l border-border pl-5">
      {ordered.map((e, i) => (
        <li key={`${e.timestamp ?? "na"}-${i}`} className="relative">
          <span
            className="absolute top-1 -left-[23px] size-2.5 rounded-full border-2 border-background bg-muted-foreground/50 data-[first=true]:bg-primary"
            data-first={i === 0}
            aria-hidden="true"
          />
          <p className="text-sm font-medium">
            {e.label?.trim() || NORMALIZED_TRACKING_LABELS[e.code] || e.rawStatus}
          </p>
          {e.description && e.description !== e.label ? (
            <p className="text-xs text-muted-foreground">{e.description}</p>
          ) : null}
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {e.timestamp ? formatDateTime(e.timestamp) : "Date non communiquée"}
            {e.location ? ` · ${e.location}` : ""}
          </p>
        </li>
      ))}
    </ol>
  );
}
