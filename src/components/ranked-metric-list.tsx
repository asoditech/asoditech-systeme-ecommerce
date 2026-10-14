import type { LucideIcon } from "lucide-react";
import { Package } from "lucide-react";
import { StaggerUl, StaggerItem } from "@/components/motion/stagger-list";

export interface RankedMetricItem {
  key: string;
  imageUrl?: string | null;
  primary: string;
  secondary?: string | null;
  /** Drives the relative bar width (normalized against the list's max) — never displayed as-is. */
  metric: number;
  /** The formatted display value on the right (e.g. "6" units, "1 240 MAD"). */
  value: string;
  valueHint?: string;
}

/**
 * A compact ranked row list — Phase 2 UI refinement. Rank badge, thumbnail
 * (or a fallback icon), primary/secondary text, a relative-share bar, and a
 * value on the right. Server-safe (no client JS): used for "Meilleures
 * ventes" today; any future "top X" ranking (suppliers, categories,
 * agents) reuses this instead of a bespoke list.
 */
export function RankedMetricList({
  items,
  fallbackIcon: FallbackIcon = Package,
}: {
  items: RankedMetricItem[];
  fallbackIcon?: LucideIcon;
}) {
  const max = Math.max(...items.map((i) => i.metric), 1);

  return (
    <StaggerUl className="space-y-1">
      {items.map((item, i) => (
        <StaggerItem key={item.key} as="li" className="flex items-center gap-3 rounded-tile px-2 py-2.5 transition-colors duration-150 hover:bg-row-hover">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-nav-active text-[11px] font-semibold text-ink-secondary tabular-nums">
            {i + 1}
          </span>
          {item.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary merchant/WooCommerce/Shopify host, can't be allow-listed for next/image
            <img src={item.imageUrl} alt="" className="size-11 shrink-0 rounded-xl object-cover" />
          ) : (
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-content">
              <FallbackIcon className="size-4 text-ink-muted" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{item.primary}</p>
            {item.secondary && <p className="truncate text-xs text-ink-muted">{item.secondary}</p>}
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-chart-track">
              <div className="h-full rounded-full bg-chart-highlight" style={{ width: `${Math.max(6, (item.metric / max) * 100)}%` }} />
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold text-ink tabular-nums">{item.value}</p>
            {item.valueHint && <p className="text-xs text-ink-muted">{item.valueHint}</p>}
          </div>
        </StaggerItem>
      ))}
    </StaggerUl>
  );
}
