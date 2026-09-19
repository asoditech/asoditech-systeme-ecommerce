import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getFinanceSummary, type PeriodRange } from "@/lib/queries/finance";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Online / Offline / Total — docs/adr/0040.
 *
 * Built from the UNDERLYING transaction sources, never from duplicated rows:
 *   Online  = delivery Orders          (`getFinanceSummary` — the EXISTING
 *             revenue definition, untouched: orders placed in the period,
 *             excluding cancelled / failed / returned / refunded)
 *   Offline = in-store Sales           (sold in the period, ROW-scoped to the
 *             viewer's store channels) minus refunds paid on returns in the period
 *   Total   = Online + Offline net — only when the viewer may read BOTH,
 *             because a total that silently included an activity the viewer has
 *             no channel for would leak it (docs/adr/0039).
 *
 * The two recognition points genuinely differ (an online order counts when
 * PLACED, before delivery; a sale counts when SOLD, cash-and-carry) — we
 * report each faithfully and label the Total as a sum, we do not invent an
 * accounting policy.
 */

type Viewer = Pick<CurrentUser, "channels">;
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: { toString(): string } | null | undefined) => (d == null ? 0 : Number(d.toString()));

export interface ChannelReportFilters {
  kind?: "all" | "online" | "offline";
  salesChannelId?: string;
  warehouseId?: string;
}

export interface ChannelReport {
  online: { revenue: number; ordersCount: number } | null;
  offline: {
    grossSales: number;
    refunds: number;
    netSales: number;
    salesCount: number;
    unitsSold: number;
    byChannel: { channelId: string; name: string; gross: number; count: number }[];
    byLocation: { warehouseId: string; name: string; gross: number; count: number }[];
    byPayment: { method: string; amount: number }[];
  } | null;
  total: { revenue: number } | null;
}

export async function getChannelReport(viewer: Viewer, range: PeriodRange, filters: ChannelReportFilters = {}): Promise<ChannelReport> {
  const kind = filters.kind ?? "all";
  const wantOnline = (kind === "all" || kind === "online") && viewer.channels.online && !filters.salesChannelId && !filters.warehouseId;
  const wantOffline = (kind === "all" || kind === "offline") && viewer.channels.offline;

  const online = wantOnline
    ? await getFinanceSummary(range).then((f) => ({ revenue: round2(num(f.revenue)), ordersCount: f.ordersCount }))
    : null;

  let offline: ChannelReport["offline"] = null;
  if (wantOffline) {
    const scope: Prisma.SaleWhereInput = {
      ...saleChannelWhere(viewer),
      ...(filters.salesChannelId ? { salesChannelId: filters.salesChannelId } : {}),
      ...(filters.warehouseId ? { warehouseId: filters.warehouseId } : {}),
    };
    const salesWhere: Prisma.SaleWhereInput = { ...scope, soldAt: { gte: range.from, lte: range.to } };

    const [gross, units, refunds, byChannel, byLocation, byPayment] = await Promise.all([
      prisma.sale.aggregate({ where: salesWhere, _sum: { total: true }, _count: true }),
      prisma.saleLine.aggregate({ where: { sale: salesWhere }, _sum: { quantity: true } }),
      // A refund is recognised in the period the goods came BACK.
      prisma.saleReturn.aggregate({ where: { receivedAt: { gte: range.from, lte: range.to }, sale: scope }, _sum: { refundAmount: true } }),
      prisma.sale.groupBy({ by: ["salesChannelId"], where: salesWhere, _sum: { total: true }, _count: true }),
      prisma.sale.groupBy({ by: ["warehouseId"], where: salesWhere, _sum: { total: true }, _count: true }),
      prisma.salePayment.groupBy({ by: ["method"], where: { sale: salesWhere }, _sum: { amount: true } }),
    ]);

    const [channels, warehouses] = await Promise.all([
      prisma.salesChannel.findMany({ where: { id: { in: byChannel.map((c) => c.salesChannelId) } }, select: { id: true, name: true } }),
      prisma.warehouse.findMany({ where: { id: { in: byLocation.map((w) => w.warehouseId) } }, select: { id: true, name: true } }),
    ]);
    const grossSales = round2(num(gross._sum.total));
    const refundTotal = round2(num(refunds._sum.refundAmount));
    offline = {
      grossSales,
      refunds: refundTotal,
      netSales: round2(grossSales - refundTotal),
      salesCount: gross._count,
      unitsSold: units._sum.quantity ?? 0,
      byChannel: byChannel.map((c) => ({ channelId: c.salesChannelId, name: channels.find((x) => x.id === c.salesChannelId)?.name ?? "—", gross: round2(num(c._sum.total)), count: c._count })),
      byLocation: byLocation.map((w) => ({ warehouseId: w.warehouseId, name: warehouses.find((x) => x.id === w.warehouseId)?.name ?? "—", gross: round2(num(w._sum.total)), count: w._count })),
      byPayment: byPayment.map((p) => ({ method: p.method, amount: round2(num(p._sum.amount)) })),
    };
  }

  return {
    online,
    offline,
    // Only when BOTH sources are present in this report — never a partial "total".
    total: online && offline ? { revenue: round2(online.revenue + offline.netSales) } : null,
  };
}
