import "server-only";

import { prisma } from "@/lib/prisma";
import type { PeriodRange } from "@/lib/queries/finance";
import { shipmentIncursDeliveryCost } from "@/lib/profitability";
import { listSupersededShipments } from "@/lib/queries/delivery";
import { asPct, countOutcomes, deliveryOutcomeRate, orderDeliveryOutcome } from "@/lib/metrics/formulas";
import type { OrderStatus, ShipmentStatus } from "@prisma/client";

/**
 * Delivery performance — by carrier and by destination city, over the
 * shipments CREATED in the window (`Shipment.createdAt` — the same anchor
 * `getDeliveryStats` uses). Note: the period P&L's delivery-cost figure is
 * anchored differently — the shipments of the orders PLACED in the period
 * (`computePeriodProfitability`) — so its cost total can differ.
 *
 * `avgDeliveryDays` is measured `shippedAt → deliveredAt` over shipments
 * that reached LIVRE and carry both timestamps. COD figures come from the
 * linked order: `codCollected` counts a delivered shipment whose order
 * payment status is PAYE; `codPending` a delivered/in-transit shipment
 * still EN_ATTENTE — the classic "livré mais pas encore encaissé" gap.
 *
 * Counts, outcomes, the success rate and COD are per ORDER — its current
 * shipment (a replaced attempt is history: listSupersededShipments) — so a
 * failed-then-re-shipped order is one delivered order, never « 1 échec +
 * 1 livraison », and its COD is counted once. Costs keep EVERY attempt:
 * each one was really charged. The rate is the one « Taux de livraison
 * réussie » (src/lib/metrics/formulas.ts).
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
  /** false = replaced by a newer attempt on the same order (cost only). */
  current: boolean;
};

function summarise(key: string, rows: ShipmentRow[]): DeliveryPerfRow {
  let inTransit = 0;
  let deliveryCost = 0;
  let returnCost = 0;
  let failureCost = 0;
  let codCollected = 0;
  let codPending = 0;
  let daysSum = 0;
  let daysN = 0;

  let total = 0;
  const outcomes: ReturnType<typeof orderDeliveryOutcome>[] = [];
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
    if (!s.current) continue; // a replaced attempt: its cost only
    total += 1;
    outcomes.push(orderDeliveryOutcome((s.order?.status ?? "EXPEDIEE") as OrderStatus, s.status as ShipmentStatus));
    if (s.status === "EN_TRANSIT") inTransit += 1;

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

  const c = countOutcomes(outcomes);
  return {
    key,
    total,
    delivered: c.delivered,
    failed: c.failed,
    returned: c.returned,
    inTransit,
    successRate: asPct(deliveryOutcomeRate(c)),
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
  const superseded = new Set((await listSupersededShipments()).map((s) => s.id));
  const found = await prisma.shipment.findMany({
    where: {
      createdAt: { gte: range.from, lte: range.to },
      // Exclude failed API-creation attempts (docs/adr/0031) — a parcel
      // that never reached the carrier. A MANUEL provider's ECHEC is a
      // real, deliberately-set failure and is kept.
      NOT: { status: "ECHEC", externalId: null, provider: { type: "API" } },
    },
    select: {
      id: true,
      status: true,
      cost: true,
      costSource: true,
      shippedAt: true,
      deliveredAt: true,
      provider: { select: { name: true } },
      order: { select: { status: true, paymentStatus: true, total: true, shippingCity: true } },
    },
  });
  const shipments: ShipmentRow[] = found.map(({ id, ...s }) => ({ ...s, current: !superseded.has(id) }));

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
