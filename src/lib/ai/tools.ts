import "server-only";

import { prisma } from "@/lib/prisma";
import { getFinanceSummary, currentMonthRange, currentDayRange } from "@/lib/queries/finance";
import { getTopProducts } from "@/lib/queries/analytics";
import { getDeliveryStats } from "@/lib/queries/delivery";
import { getLowStockCount } from "@/lib/queries/inventory";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { formatCurrency, displayOrderNumber } from "@/lib/format";
import type { UserRole } from "@prisma/client";

/**
 * Controlled tool layer for the AI assistant — see docs/adr/0009-ai-tool-layer.md.
 * Every tool here runs a specific, typed, permission-scoped Prisma query and
 * returns a plain-language French sentence built ONLY from real data. There
 * is no LLM in this phase (see docs/adr) — this is the deterministic
 * foundation an LLM would call as function tools once a provider is
 * connected (Intégrations > Fournisseur IA). No tool ever fabricates a
 * number; when the data isn't available it says so explicitly.
 *
 * `permission` gates a tool beyond the base `ai.use` right: a tool that
 * surfaces money (`finance.view`), delivery figures (`delivery.view`) etc.
 * is only offered to — and only runnable by — a role that already holds
 * that permission. `runAiToolAction` enforces it server-side; the
 * assistant page and the support widget only *show* the allowed subset.
 * The AI must never be a way around RBAC.
 */

export interface AiTool {
  id: string;
  label: string;
  /** Extra permission required on top of `ai.use`. Omit for a tool anyone
   * with `ai.use` may run. */
  permission?: Permission;
  run: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Finance (finance.view)
// ---------------------------------------------------------------------------

export async function toolRevenueThisMonth(): Promise<string> {
  const summary = await getFinanceSummary(currentMonthRange());
  return `Le chiffre d'affaires de ce mois-ci est de ${formatCurrency(summary.revenue)}, sur ${summary.ordersCount} commande(s).`;
}

export async function toolRevenueToday(): Promise<string> {
  const summary = await getFinanceSummary(currentDayRange());
  if (summary.ordersCount === 0) {
    return "Aucune commande comptabilisée aujourd'hui pour le moment.";
  }
  return `Le chiffre d'affaires d'aujourd'hui est de ${formatCurrency(summary.revenue)}, sur ${summary.ordersCount} commande(s).`;
}

export async function toolNetProfitThisMonth(): Promise<string> {
  const summary = await getFinanceSummary(currentMonthRange());
  if (summary.netProfit === null) {
    return "Le bénéfice net n'est pas calculable ce mois-ci : le coût d'achat de certains produits vendus n'est pas renseigné.";
  }
  return `Le bénéfice net estimé de ce mois-ci est de ${formatCurrency(summary.netProfit)} (basé sur les dépenses enregistrées).`;
}

export async function toolNetProfitToday(): Promise<string> {
  const summary = await getFinanceSummary(currentDayRange());
  if (summary.ordersCount === 0) {
    return "Aucune commande comptabilisée aujourd'hui — le bénéfice du jour est de 0 pour le moment.";
  }
  if (summary.netProfit === null) {
    return "Le bénéfice d'aujourd'hui n'est pas calculable : le coût d'achat de certains produits vendus n'est pas renseigné.";
  }
  return `Le bénéfice net estimé d'aujourd'hui est de ${formatCurrency(summary.netProfit)} (chiffre d'affaires ${formatCurrency(summary.revenue)}).`;
}

export async function toolMarketingSpendThisMonth(): Promise<string> {
  const { from, to } = currentMonthRange();
  const category = await prisma.expenseCategory.findFirst({ where: { name: "Publicité" } });
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

export async function toolDeliverySpendThisMonth(): Promise<string> {
  const summary = await getFinanceSummary(currentMonthRange());
  const amount = summary.deliveryCostTotal;
  if (!amount) {
    return "Aucun coût de livraison n'a encore été enregistré ce mois-ci.";
  }
  return `Le coût de livraison enregistré ce mois-ci est de ${formatCurrency(amount)} (commandes annulées exclues).`;
}

// ---------------------------------------------------------------------------
// Orders (orders.view)
// ---------------------------------------------------------------------------

export async function toolOrdersToday(): Promise<string> {
  const { from, to } = currentDayRange();
  const count = await prisma.order.count({ where: { placedAt: { gte: from, lte: to } } });
  if (count === 0) {
    return "Aucune commande n'a été passée aujourd'hui pour le moment.";
  }
  return `${count} commande(s) ont été passées aujourd'hui.`;
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
  const list = orders.map((o) => displayOrderNumber(o)).join(", ");
  return `${orders.length} commande(s) sont en retard de traitement (plus de 2 jours) : ${list}.`;
}

// ---------------------------------------------------------------------------
// Delivery (delivery.view)
// ---------------------------------------------------------------------------

export async function toolDeliveriesInTransit(): Promise<string> {
  const stats = await getDeliveryStats();
  if (stats.inTransit === 0) {
    return "Aucun colis n'est actuellement en transit.";
  }
  return `${stats.inTransit} colis sont actuellement en transit chez le transporteur.`;
}

export async function toolDeliveryPerformance(): Promise<string> {
  const stats = await getDeliveryStats();
  if (stats.total === 0) {
    return "Aucune expédition n'a encore été enregistrée — le taux de livraison réussie n'est pas disponible.";
  }
  if (stats.successRate === null) {
    return `${stats.total} expédition(s) enregistrées, dont ${stats.delivered} livrées et ${stats.failed} en échec. Le taux de réussite n'est pas encore significatif.`;
  }
  return `Le taux de livraison réussie est de ${(stats.successRate * 100).toFixed(1)} % (${stats.delivered} livrées, ${stats.failed} en échec sur ${stats.total}).`;
}

export async function toolReturnsThisMonth(): Promise<string> {
  const { from, to } = currentMonthRange();
  const count = await prisma.shipment.count({
    where: { status: "RETOURNE", createdAt: { gte: from, lte: to } },
  });
  if (count === 0) {
    return "Aucun colis retourné n'a été enregistré ce mois-ci.";
  }
  return `${count} colis ont été retournés ce mois-ci.`;
}

// ---------------------------------------------------------------------------
// Catalogue / stock
// ---------------------------------------------------------------------------

export async function toolLowStockProducts(): Promise<string> {
  const count = await getLowStockCount();
  if (count === 0) {
    return "Aucun produit n'est actuellement en stock faible.";
  }
  return `${count} produit(s) sont en stock faible ou en rupture prochaine. Consultez la page Stock pour le détail.`;
}

export async function toolBestSellingProduct(): Promise<string> {
  const [top] = await getTopProducts(1);
  if (!top || !top.product) {
    return "Aucune vente n'a encore été enregistrée.";
  }
  return `Le produit le plus vendu (toutes périodes) est « ${top.product.name} » avec ${top.unitsSold} unité(s) vendues.`;
}

export async function toolTopProductsToday(): Promise<string> {
  const { from, to } = currentDayRange();
  const grouped = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: {
      productId: { not: null },
      order: { status: { notIn: ["ANNULEE", "ECHEC"] }, placedAt: { gte: from, lte: to } },
    },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 3,
  });
  if (grouped.length === 0) {
    return "Aucune vente enregistrée aujourd'hui pour le moment.";
  }
  const products = await prisma.product.findMany({
    where: { id: { in: grouped.map((g) => g.productId).filter((id): id is string => id !== null) } },
    select: { id: true, name: true },
  });
  const parts = grouped.map((g) => {
    const name = products.find((p) => p.id === g.productId)?.name ?? "Produit supprimé";
    return `${name} (${g._sum.quantity ?? 0})`;
  });
  return `Les produits les plus vendus aujourd'hui : ${parts.join(", ")}.`;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

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

export const AI_TOOLS: readonly AiTool[] = [
  { id: "profit-today", label: "Profit aujourd'hui", permission: "finance.view", run: toolNetProfitToday },
  { id: "revenue-today", label: "Chiffre d'affaires aujourd'hui", permission: "finance.view", run: toolRevenueToday },
  { id: "orders-today", label: "Commandes aujourd'hui", permission: "orders.view", run: toolOrdersToday },
  { id: "deliveries-in-transit", label: "Colis en livraison", permission: "delivery.view", run: toolDeliveriesInTransit },
  { id: "delivery-performance", label: "Performance des livraisons", permission: "delivery.view", run: toolDeliveryPerformance },
  { id: "returns-this-month", label: "Retours ce mois-ci", permission: "delivery.view", run: toolReturnsThisMonth },
  { id: "low-stock", label: "Produits en stock faible", permission: "inventory.view", run: toolLowStockProducts },
  { id: "top-products-today", label: "Meilleures ventes du jour", permission: "products.view", run: toolTopProductsToday },
  { id: "revenue", label: "Chiffre d'affaires ce mois-ci", permission: "finance.view", run: toolRevenueThisMonth },
  { id: "profit", label: "Bénéfice net ce mois-ci", permission: "finance.view", run: toolNetProfitThisMonth },
  { id: "delivery-spend-month", label: "Coût de livraison ce mois-ci", permission: "finance.view", run: toolDeliverySpendThisMonth },
  { id: "marketing-spend", label: "Dépenses publicitaires ce mois-ci", permission: "finance.view", run: toolMarketingSpendThisMonth },
  { id: "top-product", label: "Produit le plus vendu", permission: "products.view", run: toolBestSellingProduct },
  { id: "late-orders", label: "Commandes en retard", permission: "orders.view", run: toolLateOrders },
  { id: "repeat-customers", label: "Clients fidèles", permission: "customers.view", run: toolRepeatCustomers },
] as const;

export function getAiTool(id: string): AiTool | undefined {
  return AI_TOOLS.find((t) => t.id === id);
}

/** Tools a role is allowed to run — used to render the question list so a
 * user never even sees a question they couldn't get an answer to. */
export function aiToolsForRole(role: UserRole): AiTool[] {
  return AI_TOOLS.filter((t) => !t.permission || hasPermission(role, t.permission));
}

/** The `{ id, label }` shape the client widgets need (no `run` closure). */
export function aiQuestionsForRole(role: UserRole): { id: string; label: string }[] {
  return aiToolsForRole(role).map((t) => ({ id: t.id, label: t.label }));
}
