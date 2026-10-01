import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { listAccessibleChannels, saleChannelWhere } from "@/lib/auth/channel-access";
import { readableWarehouseIds } from "@/lib/auth/location-access";
import type { CurrentUser } from "@/lib/auth/session";
import { getChannelReport, type ChannelReport } from "@/lib/queries/reports/channels";
import { bucketKey, bucketKeys, bucketLabel, type AnalyticsPeriod } from "@/lib/analytics/period";
import type { AnalyticsFilters } from "@/lib/analytics/filters";

/**
 * Offline POS analytics — docs/adr/0051. A `Sale` is never an Online order:
 * no confirmation, no delivery lifecycle. Every read is scoped by
 * `saleChannelWhere` (the viewer's OFFLINE channels AND their locations —
 * ADR 0050); the store / location filters are ANDed on top, so they can only
 * narrow that scope. Callers must hold `AnalyticsAccess.store`.
 */

type Viewer = Pick<CurrentUser, "channels" | "locations">;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function storeSaleWhere(viewer: Viewer, filters: AnalyticsFilters): Prisma.SaleWhereInput {
  return {
    AND: [
      saleChannelWhere(viewer),
      ...(filters.storeChannelId ? [{ salesChannelId: filters.storeChannelId }] : []),
      ...(filters.warehouseId ? [{ warehouseId: filters.warehouseId }] : []),
    ],
  };
}

export interface StoreOverview {
  report: NonNullable<ChannelReport["offline"]>;
  averageSaleValue: number | null;
  series: { key: string; label: string; revenue: number; orders: number }[];
}

export async function getStoreOverview(viewer: Viewer, period: AnalyticsPeriod, filters: AnalyticsFilters): Promise<StoreOverview> {
  // The existing channel report is the ONE offline definition (gross sold in
  // the period, refunds by return date, net) — reused, not re-derived.
  const [report, sales] = await Promise.all([
    getChannelReport(viewer, period.range, { kind: "offline", salesChannelId: filters.storeChannelId, warehouseId: filters.warehouseId }),
    prisma.sale.findMany({
      where: { AND: [storeSaleWhere(viewer, filters), { soldAt: { gte: period.range.from, lte: period.range.to } }] },
      select: { soldAt: true, total: true },
    }),
  ]);
  const offline = report.offline ?? { grossSales: 0, refunds: 0, netSales: 0, salesCount: 0, unitsSold: 0, byChannel: [], byLocation: [], byPayment: [] };
  const buckets = new Map(bucketKeys(period.range, period.granularity).map((k) => [k, { revenue: 0, orders: 0 }]));
  for (const s of sales) {
    const b = buckets.get(bucketKey(s.soldAt, period.granularity));
    if (!b) continue;
    b.orders += 1;
    b.revenue += Number(s.total.toString());
  }
  return {
    report: offline,
    averageSaleValue: offline.salesCount > 0 ? round2(offline.grossSales / offline.salesCount) : null,
    series: [...buckets.entries()].map(([key, b]) => ({ key, label: bucketLabel(key, period.granularity), revenue: round2(b.revenue), orders: b.orders })),
  };
}

/** Only the stores and locations the viewer may read — the filter can never offer more. */
export async function getStoreFilterOptions(viewer: Viewer) {
  const ids = readableWarehouseIds(viewer);
  const [channels, warehouses] = await Promise.all([
    listAccessibleChannels(viewer, "OFFLINE"),
    prisma.warehouse.findMany({ where: ids === null ? {} : { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { storeChannels: channels.map((c) => ({ id: c.id, name: c.name })), warehouses };
}
