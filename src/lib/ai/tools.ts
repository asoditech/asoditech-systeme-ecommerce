import "server-only";

import { prisma } from "@/lib/prisma";
import { getFinanceSummary, currentMonthRange } from "@/lib/queries/finance";
import { getTopProducts } from "@/lib/queries/analytics";
import { getLowStockCount } from "@/lib/queries/inventory";
import { formatCurrency, formatOrderNumber } from "@/lib/format";

/**
 * Controlled tool layer for the AI assistant — see docs/adr/0009-ai-tool-layer.md.
 * Every tool here runs a specific, typed, permission-scoped Prisma query and
 * returns a plain-language French sentence built ONLY from real data. There
 * is no LLM in this phase (see docs/adr) — this is the deterministic
 * foundation an LLM would call as function tools once a provider is
 * connected (Intégrations > Fournisseur IA). No tool ever fabricates a
 * number.
 */

export async function toolRevenueThisMonth(): Promise<string> {
  const summary = await getFinanceSummary(currentMonthRange());
  return `Le chiffre d'affaires de ce mois-ci est de ${formatCurrency(summary.revenue)}, sur ${summary.ordersCount} commande(s).`;
}

export async function toolNetProfitThisMonth(): Promise<string> {
  const summary = await getFinanceSummary(currentMonthRange());
  if (summary.netProfit === null) {
    return "Le bénéfice net n'est pas calculable ce mois-ci : le coût d'achat de certains produits vendus n'est pas renseigné.";
  }
  return `Le bénéfice net estimé de ce mois-ci est de ${formatCurrency(summary.netProfit)} (basé sur les dépenses enregistrées).`;
}

export async function toolBestSellingProduct(): Promise<string> {
  const [top] = await getTopProducts(1);
  if (!top || !top.product) {
    return "Aucune vente n'a encore été enregistrée.";
  }
  return `Le produit le plus vendu est "${top.product.name}" avec ${top.unitsSold} unité(s) vendues.`;
}

export async function toolMarketingSpendThisMonth(): Promise<string> {
  const { from, to } = currentMonthRange();
  const category = await prisma.expenseCategory.findUnique({ where: { name: "Publicité" } });
  if (!category) {
    return "Aucune catégorie de dépense « Publicité » n'est configurée.";
  }
  const total = await prisma.expense.aggregate({
    where: { categoryId: category.id, date: { gte: from, lte: to } },
    _sum: { amount: true },
  });
  const amount = Number(total._sum.amount ?? 0);
  if (amount === 0) {
    return "Aucune dépense publicitaire n'a été enregistrée ce mois-ci.";
  }
  return `Les dépenses publicitaires enregistrées ce mois-ci s'élèvent à ${formatCurrency(amount)}.`;
}

export async function toolLowStockProducts(): Promise<string> {
  const count = await getLowStockCount();
  if (count === 0) {
    return "Aucun produit n'est actuellement en stock faible.";
  }
  return `${count} produit(s) sont en stock faible ou en rupture prochaine. Consultez la page Stock pour le détail.`;
}

export async function toolLateOrders(): Promise<string> {
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const orders = await prisma.order.findMany({
    where: { status: { in: ["NOUVELLE", "CONFIRMEE", "EN_PREPARATION"] }, createdAt: { lte: twoDaysAgo } },
    orderBy: { createdAt: "asc" },
    take: 10,
  });
  if (orders.length === 0) {
    return "Aucune commande n'est en retard (plus de 2 jours sans expédition).";
  }
  const list = orders.map((o) => formatOrderNumber(o.orderNumber)).join(", ");
  return `${orders.length} commande(s) sont en retard de traitement (plus de 2 jours) : ${list}.`;
}

export async function toolRepeatCustomers(): Promise<string> {
  const customers = await prisma.customer.findMany({
    include: { _count: { select: { orders: true } } },
  });
  const repeat = customers.filter((c) => c._count.orders > 1);
  if (repeat.length === 0) {
    return "Aucun client n'a encore commandé plus d'une fois.";
  }
  return `${repeat.length} client(s) ont commandé plusieurs fois.`;
}

export const AI_TOOLS = [
  { id: "revenue", label: "Combien ai-je vendu ce mois-ci ?", run: toolRevenueThisMonth },
  { id: "profit", label: "Quel est mon bénéfice net ce mois-ci ?", run: toolNetProfitThisMonth },
  { id: "top-product", label: "Quel produit se vend le mieux ?", run: toolBestSellingProduct },
  { id: "marketing-spend", label: "Combien ai-je dépensé en publicité ?", run: toolMarketingSpendThisMonth },
  { id: "low-stock", label: "Quels sont mes produits en rupture prochaine ?", run: toolLowStockProducts },
  { id: "late-orders", label: "Combien de commandes sont en retard ?", run: toolLateOrders },
  { id: "repeat-customers", label: "Quels clients ont commandé plusieurs fois ?", run: toolRepeatCustomers },
] as const;
