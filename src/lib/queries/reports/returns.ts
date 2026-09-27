import "server-only";

import { prisma } from "@/lib/prisma";
import type { PeriodRange } from "@/lib/queries/finance";
import { displayOrderRecipient } from "@/lib/format";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Physical returns — built directly off `OrderReturn`/`OrderReturnLine`
 * (docs/adr/0036), the single ledger `confirmPhysicalReturnAction` writes
 * to. This is deliberately a different signal than "Ventes"' order-status
 * `returnRate` (which counts orders currently labelled Retour): this
 * report counts real physical units a human actually confirmed receiving
 * back, sellable vs damaged — it stays correct even for an order whose
 * status later changed, and for a still-shipped order nobody has marked
 * Retour at all.
 *
 * Grouped by `skuSnapshot`/`nameSnapshot` (stored on the line itself),
 * never by `orderItem.productId` — so a product deleted after the fact
 * still reports correctly, same as every other return-history surface.
 */

export interface ReturnsReportTotals {
  returnEvents: number;
  ordersReturned: number;
  unitsSellable: number;
  unitsDamaged: number;
  unitsTotal: number;
}

export interface ReturnsByProductRow {
  key: string;
  name: string;
  sku: string;
  unitsSellable: number;
  unitsDamaged: number;
  unitsTotal: number;
  lines: number;
}

export interface ReturnsByOrderRow {
  orderReturnId: string;
  orderId: string;
  orderNumber: number;
  displayNumber: number | null;
  customerName: string;
  receivedAt: Date;
  receivedByName: string | null;
  unitsSellable: number;
  unitsDamaged: number;
  note: string | null;
}

export interface ReturnsReport {
  totals: ReturnsReportTotals;
  byProduct: ReturnsByProductRow[];
  byOrder: ReturnsByOrderRow[];
}

export async function getReturnsReport(range: PeriodRange): Promise<ReturnsReport> {
  const returns = await prisma.orderReturn.findMany({
    where: { receivedAt: { gte: range.from, lte: range.to } },
    orderBy: { receivedAt: "desc" },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          displayNumber: true,
          shippingName: true,
          customer: { select: { fullName: true } },
        },
      },
      receivedBy: { select: { name: true } },
      lines: { select: { nameSnapshot: true, skuSnapshot: true, quantitySellable: true, quantityDamaged: true } },
    },
  });

  let unitsSellable = 0;
  let unitsDamaged = 0;
  const orderIds = new Set<string>();
  const byProductMap = new Map<string, ReturnsByProductRow>();
  const byOrder: ReturnsByOrderRow[] = [];

  for (const r of returns) {
    orderIds.add(r.orderId);
    let eventSellable = 0;
    let eventDamaged = 0;

    for (const line of r.lines) {
      unitsSellable += line.quantitySellable;
      unitsDamaged += line.quantityDamaged;
      eventSellable += line.quantitySellable;
      eventDamaged += line.quantityDamaged;

      const key = line.skuSnapshot || line.nameSnapshot;
      const existing = byProductMap.get(key);
      if (existing) {
        existing.unitsSellable += line.quantitySellable;
        existing.unitsDamaged += line.quantityDamaged;
        existing.unitsTotal += line.quantitySellable + line.quantityDamaged;
        existing.lines += 1;
      } else {
        byProductMap.set(key, {
          key,
          name: line.nameSnapshot,
          sku: line.skuSnapshot,
          unitsSellable: line.quantitySellable,
          unitsDamaged: line.quantityDamaged,
          unitsTotal: line.quantitySellable + line.quantityDamaged,
          lines: 1,
        });
      }
    }

    byOrder.push({
      orderReturnId: r.id,
      orderId: r.orderId,
      orderNumber: r.order.orderNumber,
      displayNumber: r.order.displayNumber,
      // Per-order recipient snapshot, not the (mutable, sometimes
      // customer-matched-by-phone-shared) live Customer name — two orders
      // under one merged Customer record must not display the same name.
      customerName: displayOrderRecipient(r.order),
      receivedAt: r.receivedAt,
      receivedByName: r.receivedBy?.name ?? null,
      unitsSellable: eventSellable,
      unitsDamaged: eventDamaged,
      note: r.note,
    });
  }

  return {
    totals: {
      returnEvents: returns.length,
      ordersReturned: orderIds.size,
      unitsSellable,
      unitsDamaged,
      unitsTotal: unitsSellable + unitsDamaged,
    },
    byProduct: [...byProductMap.values()].sort((a, b) => b.unitsTotal - a.unitsTotal),
    byOrder,
  };
}

// ---------------------------------------------------------------------------
// Offline (in-store) returns — Batch 15. Same shape and posture as the Online
// report above (built off the real ledger — `SaleReturn`/`SaleReturnLine`,
// docs/adr/0040 — grouped by snapshot, never the live product), a SEPARATE
// query rather than a merged one: an Order return and a Sale return are
// different business events (placed-then-shipped vs. cash-and-carry) and
// must never be reported as the same row. Channel-scoped via
// `saleChannelWhere` — never a bare `sale.findMany`, so a viewer only ever
// sees returns for their own authorized store channels (docs/adr/0039).
// ---------------------------------------------------------------------------

export interface OfflineReturnsByOrderRow {
  saleReturnId: string;
  saleId: string;
  saleNumber: number;
  displayNumber: number | null;
  customerName: string;
  channelName: string;
  receivedAt: Date;
  receivedByName: string | null;
  unitsSellable: number;
  unitsDamaged: number;
  refundAmount: number;
  note: string | null;
}

export interface OfflineReturnsReport {
  totals: ReturnsReportTotals & { refundTotal: number };
  byProduct: ReturnsByProductRow[];
  bySale: OfflineReturnsByOrderRow[];
}

export async function getOfflineReturnsReport(
  range: PeriodRange,
  viewer: Pick<CurrentUser, "channels">
): Promise<OfflineReturnsReport> {
  const returns = await prisma.saleReturn.findMany({
    where: { receivedAt: { gte: range.from, lte: range.to }, sale: saleChannelWhere(viewer) },
    orderBy: { receivedAt: "desc" },
    include: {
      sale: {
        select: {
          id: true,
          saleNumber: true,
          displayNumber: true,
          customerLabel: true,
          customer: { select: { fullName: true } },
          salesChannel: { select: { name: true } },
        },
      },
      lines: { select: { nameSnapshot: true, skuSnapshot: true, quantitySellable: true, quantityDamaged: true } },
    },
  });

  let unitsSellable = 0;
  let unitsDamaged = 0;
  let refundTotal = 0;
  const saleIds = new Set<string>();
  const byProductMap = new Map<string, ReturnsByProductRow>();
  const bySale: OfflineReturnsByOrderRow[] = [];

  for (const r of returns) {
    saleIds.add(r.saleId);
    refundTotal += Number(r.refundAmount);
    let eventSellable = 0;
    let eventDamaged = 0;

    for (const line of r.lines) {
      unitsSellable += line.quantitySellable;
      unitsDamaged += line.quantityDamaged;
      eventSellable += line.quantitySellable;
      eventDamaged += line.quantityDamaged;

      const key = line.skuSnapshot || line.nameSnapshot;
      const existing = byProductMap.get(key);
      if (existing) {
        existing.unitsSellable += line.quantitySellable;
        existing.unitsDamaged += line.quantityDamaged;
        existing.unitsTotal += line.quantitySellable + line.quantityDamaged;
        existing.lines += 1;
      } else {
        byProductMap.set(key, {
          key,
          name: line.nameSnapshot,
          sku: line.skuSnapshot,
          unitsSellable: line.quantitySellable,
          unitsDamaged: line.quantityDamaged,
          unitsTotal: line.quantitySellable + line.quantityDamaged,
          lines: 1,
        });
      }
    }

    bySale.push({
      saleReturnId: r.id,
      saleId: r.saleId,
      saleNumber: r.sale.saleNumber,
      displayNumber: r.sale.displayNumber,
      customerName: r.sale.customerLabel ?? r.sale.customer?.fullName ?? "—",
      channelName: r.sale.salesChannel.name,
      receivedAt: r.receivedAt,
      receivedByName: r.receivedByName,
      unitsSellable: eventSellable,
      unitsDamaged: eventDamaged,
      refundAmount: Number(r.refundAmount),
      note: r.note,
    });
  }

  return {
    totals: {
      returnEvents: returns.length,
      ordersReturned: saleIds.size,
      unitsSellable,
      unitsDamaged,
      unitsTotal: unitsSellable + unitsDamaged,
      refundTotal: Math.round(refundTotal * 100) / 100,
    },
    byProduct: [...byProductMap.values()].sort((a, b) => b.unitsTotal - a.unitsTotal),
    bySale,
  };
}
