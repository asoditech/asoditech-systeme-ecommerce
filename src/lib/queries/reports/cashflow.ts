import "server-only";

import { prisma } from "@/lib/prisma";
import { computePeriodProfitability } from "@/lib/profitability";
import { NON_REVENUE_ORDER_STATUSES } from "@/lib/metrics/formulas";
import type { PeriodRange } from "@/lib/queries/finance";

/**
 * Cash view of the period — money actually expected in vs money going
 * out. NOT accrual P&L (that's the Finance page / `computePeriodProfitability`,
 * which this reuses for COGS and margin context).
 *
 * Inflows: orders placed in the window, split by payment status (encaissé
 * = PAYE, à encaisser = EN_ATTENTE / PARTIELLEMENT_PAYE) and by payment
 * method (so COD vs virement vs carte is visible). « À encaisser » leaves
 * out orders that will never pay (cancelled, failed, returned, refunded —
 * src/lib/metrics/formulas.ts NON_REVENUE_ORDER_STATUSES). A partly paid
 * order counts its FULL total there: the amount already paid is not
 * recorded anywhere (data-model limit — `pendingPartial` says how much of
 * the figure is concerned). « Remboursé » = COMPLETE refunds on the
 * window's orders — the one definition Finance and /analyses use. Outflows:
 * expenses dated in the window, by category, plus total delivery cost.
 * `netCash` is encaissé − refunds paid back on those encaissé orders −
 * outflows; `projectedNet` assumes the à-encaisser bucket lands too.
 */

export interface CashflowReport {
  inflows: {
    collected: number;
    pending: number;
    /** Part of `pending` from PARTIELLEMENT_PAYE orders, counted at their full total. */
    pendingPartial: number;
    refunded: number;
    byMethod: { method: string; collected: number; pending: number }[];
  };
  outflows: {
    expensesByCategory: { category: string; amount: number }[];
    expensesTotal: number;
    deliveryCost: number;
    total: number;
  };
  netCash: number;
  projectedNet: number;
  grossMarginPct: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const METHOD_LABELS: Record<string, string> = {
  PAIEMENT_LIVRAISON: "Paiement à la livraison",
  VIREMENT_BANCAIRE: "Virement bancaire",
  CARTE_BANCAIRE: "Carte bancaire",
  MOBILE_MONEY: "Mobile money",
  AUTRE: "Autre",
};

export async function getCashflowReport(range: PeriodRange): Promise<CashflowReport> {
  const [orders, expenses, pnl] = await Promise.all([
    prisma.order.findMany({
      where: { placedAt: { gte: range.from, lte: range.to } },
      select: {
        total: true,
        status: true,
        paymentStatus: true,
        paymentMethod: true,
        refunds: { where: { status: "COMPLETE" }, select: { amount: true } },
      },
    }),
    prisma.expense.findMany({
      where: { date: { gte: range.from, lte: range.to } },
      select: { amount: true, category: { select: { name: true } } },
    }),
    computePeriodProfitability(range),
  ]);

  let collected = 0;
  let pending = 0;
  let pendingPartial = 0;
  let refunded = 0;
  let refundedOnCollected = 0;
  const byMethod = new Map<string, { collected: number; pending: number }>();
  for (const o of orders) {
    const amount = Number(o.total);
    const refunds = o.refunds.reduce((n, r) => n + Number(r.amount), 0);
    refunded += refunds;
    const m = byMethod.get(o.paymentMethod) ?? { collected: 0, pending: 0 };
    if (o.paymentStatus === "PAYE") {
      collected += amount;
      refundedOnCollected += refunds;
      m.collected += amount;
    } else if (
      (o.paymentStatus === "EN_ATTENTE" || o.paymentStatus === "PARTIELLEMENT_PAYE") &&
      !NON_REVENUE_ORDER_STATUSES.includes(o.status)
    ) {
      pending += amount;
      if (o.paymentStatus === "PARTIELLEMENT_PAYE") pendingPartial += amount;
      m.pending += amount;
    }
    byMethod.set(o.paymentMethod, m);
  }

  const expByCat = new Map<string, number>();
  let expensesTotal = 0;
  for (const e of expenses) {
    const amt = Number(e.amount);
    expensesTotal += amt;
    expByCat.set(e.category.name, (expByCat.get(e.category.name) ?? 0) + amt);
  }

  const deliveryCost = pnl.deliveryCostTotal;
  const outflowsTotal = round2(expensesTotal + deliveryCost);

  return {
    inflows: {
      collected: round2(collected),
      pending: round2(pending),
      pendingPartial: round2(pendingPartial),
      refunded: round2(refunded),
      byMethod: [...byMethod.entries()]
        .map(([method, v]) => ({
          method: METHOD_LABELS[method] ?? method,
          collected: round2(v.collected),
          pending: round2(v.pending),
        }))
        .sort((a, b) => b.collected + b.pending - (a.collected + a.pending)),
    },
    outflows: {
      expensesByCategory: [...expByCat.entries()]
        .map(([category, amount]) => ({ category, amount: round2(amount) }))
        .sort((a, b) => b.amount - a.amount),
      expensesTotal: round2(expensesTotal),
      deliveryCost: round2(deliveryCost),
      total: outflowsTotal,
    },
    netCash: round2(collected - refundedOnCollected - outflowsTotal),
    projectedNet: round2(collected - refundedOnCollected + pending - outflowsTotal),
    grossMarginPct: pnl.grossMarginPct,
  };
}
