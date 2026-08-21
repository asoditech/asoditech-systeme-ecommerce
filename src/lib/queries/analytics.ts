import "server-only";

import { prisma } from "@/lib/prisma";

export async function getRevenueTrend(days = 30) {
  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);

  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: from }, status: { notIn: ["ANNULEE", "ECHEC"] } },
    select: { createdAt: true, total: true },
  });

  const byDay = new Map<string, number>();
  for (let i = 0; i <= days; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    byDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const o of orders) {
    const key = o.createdAt.toISOString().slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + Number(o.total));
  }

  return Array.from(byDay.entries()).map(([date, revenue]) => ({ date, revenue }));
}

export async function getOrderStatusBreakdown() {
  const grouped = await prisma.order.groupBy({ by: ["status"], _count: true });
  return grouped.map((g) => ({ status: g.status, count: g._count }));
}

export async function getTopProducts(limit = 5) {
  const grouped = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: { productId: { not: null }, order: { status: { notIn: ["ANNULEE", "ECHEC"] } } },
    _sum: { quantity: true, total: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });

  const products = await prisma.product.findMany({
    where: { id: { in: grouped.map((g) => g.productId).filter((id): id is string => id !== null) } },
  });

  return grouped.map((g) => ({
    product: products.find((p) => p.id === g.productId),
    unitsSold: g._sum.quantity ?? 0,
    revenue: g._sum.total ?? 0,
  }));
}
