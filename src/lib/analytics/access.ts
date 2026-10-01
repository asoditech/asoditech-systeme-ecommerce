import { redirect } from "next/navigation";
import type { CurrentUser } from "@/lib/auth/session";
import { userHasPermission } from "@/lib/auth/permissions";

/**
 * What the analytics module may show a viewer (docs/adr/0051). Computed from
 * the effective access already resolved for the request — never from the UI.
 * Every page AND every CSV export resolves this once and passes it down; a
 * section the viewer may not read is neither queried nor rendered.
 *
 * - `online`      — Online order analytics (confirmation, delivery, revenue,
 *                   products, sources): an ONLINE channel (docs/adr/0039 —
 *                   the Online business is scoped by channel kind; Online
 *                   orders have no location model, ADR 0050).
 * - `store`       — Offline POS analytics: an OFFLINE channel + the tenant's
 *                   `storeChannels` capability; rows are channel- AND
 *                   location-scoped by `saleChannelWhere` (ADR 0050).
 * - `commissions` — the commission ledger: `commissions.view` (ONLINE domain).
 * - `finance`     — cost of goods, margin, profit: `finance.view`. Without it
 *                   those figures are never computed, not merely hidden.
 */
export interface AnalyticsAccess {
  online: boolean;
  store: boolean;
  commissions: boolean;
  finance: boolean;
}

type Viewer = Pick<CurrentUser, "permissions" | "channels" | "capabilities">;

export function analyticsAccess(viewer: Viewer): AnalyticsAccess {
  const allowed = userHasPermission(viewer, "analytics.view");
  return {
    online: allowed && viewer.channels.online,
    store: allowed && viewer.channels.offline && viewer.capabilities.has("storeChannels"),
    commissions: allowed && viewer.channels.online && userHasPermission(viewer, "commissions.view"),
    finance: allowed && userHasPermission(viewer, "finance.view"),
  };
}

export type AnalyticsSection = "overview" | "confirmation" | "delivery" | "products" | "commissions" | "sources";

/** Whether a section has anything this viewer may read. */
export function canOpenSection(access: AnalyticsAccess, section: AnalyticsSection): boolean {
  switch (section) {
    case "overview":
    case "products":
    case "sources":
      return access.online || access.store;
    case "confirmation":
    case "delivery":
      return access.online;
    case "commissions":
      return access.commissions;
  }
}

/** Page guard — the viewer is authenticated, they just may not see this. */
export function requireSection(access: AnalyticsAccess, section: AnalyticsSection): void {
  if (!canOpenSection(access, section)) redirect("/acces-refuse");
}
