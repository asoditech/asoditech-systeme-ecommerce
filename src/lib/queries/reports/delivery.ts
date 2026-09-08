import "server-only";

import { prisma } from "@/lib/prisma";
import type { PeriodRange } from "@/lib/queries/finance";

/**
 * Delivery performance — by carrier and by destination city, over the
 * shipments CREATED in the window (same anchor `getDeliveryStats` and the
 * period P&L's delivery-cost figure use).
 *
 * `avgDeliveryDays` is measured `shippedAt → deliveredAt` over shipments
 * that reached LIVRE and carry both timestamps. COD figures come from the
 * linked order: `codCollected` counts a delivered shipment whose order
 * payment status is PAYE; `codPending` a delivered/in-transit shipment
 * still EN_ATTENTE — the classic "livré mais pas encore encaissé" gap.
 */

export interface DeliveryPerfRow {
  key: string;
  total: number;
  delivered: number;
  failed: number;
  returned: number;
  inTransit: number;
  successRate: number | null;
  avgDeliveryDays: number | null;
  shippingCost: number;
  codCollected: number;
  codPending: number;
}

export interface DeliveryPerformanceReport {
  overall: DeliveryPerfRow;
  byProvider: DeliveryPerfRow[];
  byCity: DeliveryPerfRow[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

type ShipmentRow = {
  status: string;
  cost: unknown;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  provider: { name: string } | null;
  order: { paymentStatus: string; total: unknown; shippingCity: string | null } | null;
};

function summarise(key: string, rows: ShipmentRow[]): DeliveryPerfRow {
  let delivered = 0;
  let failed = 0;
  let returned = 0;
  let inTransit = 0;
  let shippingCost = 0;
  let codCollected = 0;
  let codPending = 0;
  let daysSum = 0;
  let daysN = 0;

  for (const s of rows) {
    if (s.cost != null) shippingCost += Number(s.cost);
    if (s.status === "LIVRE") delivered += 1;
    else if (s.status === "ECHEC") failed += 1;
    else if (s.status === "RETOURNE") returned += 1;
    else if (s.status === "EN_TRANSIT") inTransit += 1;

    if (s.status === "LIVRE" && s.shippedAt && s.deliveredAt) {
      daysSum += (s.deliveredAt.getTime() - s.shippedAt.getTime()) / 86_400_000;
      daysN += 1;
    }
    if (s.order) {
      const amount = Number(s.order.total);
      if (s.status === "LIVRE" && s.order.paymentStatus === "PAYE") codCollected += amount;
      else if ((s.status === "LIVRE" || s.status === "EN_TRANSIT") && s.order.paymentStatus === "EN_ATTENTE")
        codPending += amount;
    }
  }

  return {
    key,
    total: rows.length,
    delivered,
    failed,
    returned,
    inTransit,
    successRate: rows.length > 0 ? round1((delivered / rows.length) * 100) : null,
    avgDeliveryDays: daysN > 0 ? round1(daysSum / daysN) : null,
    shippingCost: round2(shippingCost),
    codCollected: round2(codCollected),
    codPending: round2(codPending),
  };
}

export async function getDeliveryPerformanceReport(range: PeriodRange): Promise<DeliveryPerformanceReport> {
  const shipments = (await prisma.shipment.findMany({
    where: { createdAt: { gte: range.from, lte: range.to } },
    select: {
      status: true,
      cost: true,
      shippedAt: true,
      deliveredAt: true,
      provider: { select: { name: true } },
      order: { select: { paymentStatus: true, total: true, shippingCity: true } },
    },
  })) as ShipmentRow[];

  const byProviderMap = new Map<string, ShipmentRow[]>();
  const byCityMap = new Map<string, ShipmentRow[]>();
  for (const s of shipments) {
    const p = s.provider?.name ?? "—";
    (byProviderMap.get(p) ?? byProviderMap.set(p, []).get(p)!).push(s);
    const c = s.order?.shippingCity?.trim() || "Ville inconnue";
    (byCityMap.get(c) ?? byCityMap.set(c, []).get(c)!).push(s);
  }

  return {
    overall: summarise("Global", shipments),
    byProvider: [...byProviderMap.entries()]
      .map(([k, rows]) => summarise(k, rows))
      .sort((a, b) => b.total - a.total),
    byCity: [...byCityMap.entries()]
      .map(([k, rows]) => summarise(k, rows))
      .sort((a, b) => b.total - a.total),
  };
}
