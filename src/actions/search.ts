"use server";

import { productSearchWhereWithOptions } from "@/lib/queries/products";
import { productLevelMatches, variantLabel } from "@/lib/catalog/lookup";
import { prisma } from "@/lib/prisma";
import { requireUserForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { displayOrderNumber, displaySaleNumber } from "@/lib/format";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { productQuickActions, type QuickSearchAction } from "@/lib/catalog/quick-actions";

export interface QuickSearchResult {
  id: string;
  type: "customer" | "product" | "order" | "sale" | "supplier";
  title: string;
  subtitle: string;
  href: string;
  /** Product results only: the actions this user may run — computed here, on the server. */
  actions?: QuickSearchAction[];
}

/** Global command-palette search, scoped to what the current user is allowed to see. */
export async function quickSearchAction(query: string): Promise<QuickSearchResult[]> {
  const user = await requireUserForAction();
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const results: QuickSearchResult[] = [];

  if (userHasPermission(user, "customers.view")) {
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

  if (userHasPermission(user, "products.view")) {
    const search = await productSearchWhereWithOptions(trimmed);
    const optionIds = [...search.optionVariationIds];
    const products = await prisma.product.findMany({
      where: { OR: search.or },
      include: {
        _count: { select: { variations: true } },
        // For a variation-level match ("Rouge", "XL", part of a variation SKU),
        // the matching variations explain the result.
        variations: {
          where: { OR: [{ id: { in: optionIds } }, { sku: { contains: trimmed, mode: "insensitive" } }] },
          select: { sku: true, attributes: true },
          take: 3,
        },
      },
      take: 5,
    });
    results.push(
      ...products.map((p) => ({
        id: p.id,
        type: "product" as const,
        title: p.name,
        subtitle: productLevelMatches(p, trimmed)
          ? p.sku
          : [p.sku, ...p.variations.map((v) => variantLabel(v.attributes)).filter(Boolean)].join(" · "),
        href: `/produits/${p.id}`,
        actions: productQuickActions(user, { id: p.id, sku: p.sku, variationCount: p._count.variations }),
      }))
    );
  }

  if (userHasPermission(user, "orders.view")) {
    const numericQuery = Number(trimmed.replace(/\D/g, ""));
    const orders = Number.isFinite(numericQuery) && numericQuery > 0
      ? await prisma.order.findMany({
          where: { orderNumber: numericQuery },
          include: { customer: true },
          take: 5,
        })
      : [];
    const business = orders.length > 0 ? await getReportBusinessInfo() : null;
    results.push(
      ...orders.map((o) => ({
        id: o.id,
        type: "order" as const,
        title: displayOrderNumber(o, business?.orderNumberPrefix),
        subtitle: o.customer.fullName,
        href: `/commandes/${o.id}`,
      }))
    );
  }

  // In-store sales (docs/adr/0040) — ROW-scoped to the viewer's store channels
  // (`sales.view` only exists for a user with an OFFLINE channel, docs/adr/0039).
  if (userHasPermission(user, "sales.view")) {
    const numeric = Number(trimmed.replace(/\D/g, ""));
    const sales = await prisma.sale.findMany({
      where: {
        ...saleChannelWhere(user),
        OR: [
          ...(Number.isFinite(numeric) && numeric > 0 ? [{ saleNumber: numeric }, { displayNumber: numeric }] : []),
          { customerLabel: { contains: trimmed, mode: "insensitive" as const } },
          { lines: { some: { OR: [{ barcodeSnapshot: trimmed }, { skuSnapshot: { equals: trimmed, mode: "insensitive" as const } }] } } },
        ],
      },
      orderBy: { soldAt: "desc" },
      take: 5,
    });
    results.push(
      ...sales.map((s) => ({
        id: s.id,
        type: "sale" as const,
        title: displaySaleNumber(s),
        subtitle: s.customerLabel ?? "Vente magasin",
        href: `/ventes/${s.id}`,
      }))
    );
  }

  if (userHasPermission(user, "suppliers.view")) {
    const suppliers = await prisma.supplier.findMany({
      where: { OR: [{ name: { contains: trimmed, mode: "insensitive" } }, { phone: { contains: trimmed } }] },
      take: 5,
    });
    results.push(
      ...suppliers.map((s) => ({
        id: s.id,
        type: "supplier" as const,
        title: s.name,
        subtitle: s.phone ?? s.city ?? "Fournisseur",
        href: `/fournisseurs/${s.id}`,
      }))
    );
  }

  return results;
}
