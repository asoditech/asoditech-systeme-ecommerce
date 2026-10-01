import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bucketKey, bucketKeys, bucketLabel, type AnalyticsPeriod } from "@/lib/analytics/period";
import { orderFilterWhere, type AnalyticsFilters } from "@/lib/analytics/filters";

/**
 * Commission analytics — docs/adr/0051. READ-ONLY over the existing
 * append-only `CommissionEntry` ledger (docs/adr/0022, 0049): EARNED is
 * written when an order reaches LIVREE at the agent's snapshot rate, REVERSED
 * (a negative amount) when it later leaves LIVREE. Nothing here recomputes a
 * rate or an entitlement — each entry's own `amount` is authoritative, and
 * its `createdAt` (the event date) places it in a period. An agent
 * deactivated after attribution keeps the entries the ledger gave them.
 *
 * Callers must hold `AnalyticsAccess.commissions` (`commissions.view`).
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: { toString(): string } | null | undefined) => (d == null ? 0 : Number(d.toString()));

export interface AgentCommissionRow {
  agentId: string;
  name: string;
  active: boolean;
  earned: number;
  earnedCount: number;
  /** Positive amount reversed (the ledger stores it negative). */
  reversed: number;
  reversedCount: number;
  net: number;
}

export interface CommissionAnalytics {
  earned: number;
  earnedCount: number;
  reversed: number;
  reversedCount: number;
  net: number;
  byAgent: AgentCommissionRow[];
  series: { key: string; label: string; earned: number; reversed: number; net: number }[];
}

export async function getCommissionAnalytics(period: AnalyticsPeriod, filters: AnalyticsFilters): Promise<CommissionAnalytics> {
  const orderFilter = orderFilterWhere(filters);
  const where: Prisma.CommissionEntryWhereInput = {
    createdAt: { gte: period.range.from, lte: period.range.to },
    ...(filters.agentId ? { agentId: filters.agentId } : {}),
    ...(Object.keys(orderFilter).length ? { order: orderFilter } : {}),
  };
  const [groups, entries] = await Promise.all([
    prisma.commissionEntry.groupBy({ by: ["agentId", "type"], where, _sum: { amount: true }, _count: true }),
    prisma.commissionEntry.findMany({ where, select: { createdAt: true, type: true, amount: true } }),
  ]);
  const agentIds = [...new Set(groups.map((g) => g.agentId))];
  const agents = agentIds.length
    ? await prisma.commissionAgent.findMany({ where: { id: { in: agentIds } }, select: { id: true, isActive: true, user: { select: { name: true } } } })
    : [];

  const rows = new Map<string, AgentCommissionRow>();
  for (const g of groups) {
    const a = agents.find((x) => x.id === g.agentId);
    const r = rows.get(g.agentId) ?? { agentId: g.agentId, name: a?.user.name ?? "—", active: a?.isActive ?? false, earned: 0, earnedCount: 0, reversed: 0, reversedCount: 0, net: 0 };
    const amount = num(g._sum.amount);
    if (g.type === "EARNED") {
      r.earned += amount;
      r.earnedCount += g._count;
    } else {
      r.reversed += -amount;
      r.reversedCount += g._count;
    }
    r.net += amount;
    rows.set(g.agentId, r);
  }
  const byAgent = [...rows.values()].map((r) => ({ ...r, earned: round2(r.earned), reversed: round2(r.reversed), net: round2(r.net) }));

  const buckets = new Map(bucketKeys(period.range, period.granularity).map((k) => [k, { earned: 0, reversed: 0 }]));
  for (const e of entries) {
    const b = buckets.get(bucketKey(e.createdAt, period.granularity));
    if (!b) continue;
    if (e.type === "EARNED") b.earned += num(e.amount);
    else b.reversed += -num(e.amount);
  }

  const earned = round2(byAgent.reduce((n, r) => n + r.earned, 0));
  const reversed = round2(byAgent.reduce((n, r) => n + r.reversed, 0));
  return {
    earned,
    earnedCount: byAgent.reduce((n, r) => n + r.earnedCount, 0),
    reversed,
    reversedCount: byAgent.reduce((n, r) => n + r.reversedCount, 0),
    net: round2(earned - reversed),
    byAgent: byAgent.sort((a, b) => b.net - a.net),
    series: [...buckets.entries()].map(([key, b]) => ({
      key,
      label: bucketLabel(key, period.granularity),
      earned: round2(b.earned),
      reversed: round2(b.reversed),
      net: round2(b.earned - b.reversed),
    })),
  };
}

export async function listCommissionAgentOptions() {
  const agents = await prisma.commissionAgent.findMany({ select: { id: true, isActive: true, user: { select: { name: true } } }, orderBy: { user: { name: "asc" } } });
  return agents.map((a) => ({ id: a.id, name: a.isActive ? a.user.name : `${a.user.name} (inactif)` }));
}
