import "server-only";

import { prisma } from "@/lib/prisma";
import type { PeriodRange } from "@/lib/queries/finance";
import { shipmentIncursDeliveryCost } from "@/lib/profitability";

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
  /** Total recorded shipment cost — `deliveryCost + returnCost +
   * failureCost` (docs/adr/0032). */
  shippingCost: number;
  /** Successful-delivery carrier charges (CARRIER_API + in-flight carrier
   * estimates / manual-provider entries / manual overrides). */
  deliveryCost: number;
  /** Return-rule charges. */
  returnCost: number;
  /** Failure-rule charges. */
  failureCost: number;
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
  costSource: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  provider: { name: string } | null;
  order: { status: string; paymentStatus: string; total: unknown; shippingCity: string | null } | null;
};

function summarise(key: string, rows: ShipmentRow[]): DeliveryPerfRow {
  let delivered = 0;
  let failed = 0;
  let returned = 0;
  let inTransit = 0;
  let deliveryCost = 0;
  let returnCost = 0;
  let failureCost = 0;
  let codCollected = 0;
  let codPending = 0;
  let daysSum = 0;
  let daysN = 0;

  for (const s of rows) {
    // Client feedback #3: a cancelled order's parcel never reached the
    // customer, and a cancelled shipment completed no delivery service —
    // neither incurs a delivery deduction. RETURN_RULE / FAILURE_RULE
    // charges belong to RETOUR / ECHEC orders and never carry an ANNULE
    // status, so this guard leaves them untouched (docs/adr/0032).
    if (s.cost != null && shipmentIncursDeliveryCost(s.order?.status, s.status)) {
      const amt = Number(s.cost);
      if (s.costSource === "RETURN_RULE") returnCost += amt;
      else if (s.costSource === "FAILURE_RULE") failureCost += amt;
      else deliveryCost += amt; // CARRIER_API, MANUAL_OVERRIDE, or null (estimate)
    }
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
    shippingCost: round2(deliveryCost + returnCost + failureCost),
    deliveryCost: round2(deliveryCost),
    returnCost: round2(returnCost),
    failureCost: round2(failureCost),
    codCollected: round2(codCollected),
    codPending: round2(codPending),
  };
}

export async function getDeliveryPerformanceReport(range: PeriodRange): Promise<DeliveryPerformanceReport> {
  const shipments = (await prisma.shipment.findMany({
    where: {
      createdAt: { gte: range.from, lte: range.to },
      // Exclude failed API-creation attempts (docs/adr/0031) — a parcel
      // that never reached the carrier. A MANUEL provider's ECHEC is a
      // real, deliberately-set failure and is kept.
      NOT: { status: "ECHEC", externalId: null, provider: { type: "API" } },
    },
    select: {
      status: true,
      cost: true,
      costSource: true,
      shippedAt: true,
      deliveredAt: true,
      provider: { select: { name: true } },
      order: { select: { status: true, paymentStatus: true, total: true, shippingCity: true } },
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
