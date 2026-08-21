"use server";

import { prisma } from "@/lib/prisma";
import { requireUserForAction } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { formatOrderNumber } from "@/lib/format";

export interface QuickSearchResult {
  id: string;
  type: "customer" | "product" | "order";
  title: string;
  subtitle: string;
  href: string;
}

/** Global command-palette search, scoped to what the current user is allowed to see. */
export async function quickSearchAction(query: string): Promise<QuickSearchResult[]> {
  const user = await requireUserForAction();
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const results: QuickSearchResult[] = [];

  if (hasPermission(user.role, "customers.view")) {
    const customers = await prisma.customer.findMany({
      where: {
        OR: [
          { fullName: { contains: trimmed, mode: "insensitive" } },
          { phone: { contains: trimmed, mode: "insensitive" } },
          { email: { contains: trimmed, mode: "insensitive" } },
        ],
      },
      take: 5,
    });
    results.push(
      ...customers.map((c) => ({
        id: c.id,
        type: "customer" as const,
        title: c.fullName,
        subtitle: c.phone ?? c.email ?? "Client",
        href: `/clients/${c.id}`,
      }))
    );
  }

  if (hasPermission(user.role, "products.view")) {
    const products = await prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: trimmed, mode: "insensitive" } },
          { sku: { contains: trimmed, mode: "insensitive" } },
        ],
      },
      take: 5,
    });
    results.push(
      ...products.map((p) => ({
        id: p.id,
        type: "product" as const,
        title: p.name,
        subtitle: p.sku,
        href: `/produits/${p.id}`,
      }))
    );
  }

  if (hasPermission(user.role, "orders.view")) {
    const numericQuery = Number(trimmed.replace(/\D/g, ""));
    const orders = Number.isFinite(numericQuery) && numericQuery > 0
      ? await prisma.order.findMany({
          where: { orderNumber: numericQuery },
          include: { customer: true },
          take: 5,
        })
      : [];
    results.push(
      ...orders.map((o) => ({
        id: o.id,
        type: "order" as const,
        title: formatOrderNumber(o.orderNumber),
        subtitle: o.customer.fullName,
        href: `/commandes/${o.id}`,
      }))
    );
  }

  return results;
}
