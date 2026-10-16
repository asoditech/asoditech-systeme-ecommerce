"use server";

import { productSearchWhereWithOptions } from "@/lib/queries/products";
import { productLevelMatches, variantLabel } from "@/lib/catalog/lookup";
import { customerVisibilityWhere } from "@/lib/customers/visibility";
import { normalizeScannedCustomerCode } from "@/lib/customers/barcode";
import { customerPhoneSearchKeys } from "@/lib/customers/identity";
import { prisma } from "@/lib/prisma";
import { requireUserForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { displayOrderNumber, displaySaleNumber } from "@/lib/format";
import { saleChannelWhere } from "@/lib/auth/channel-access";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { findQuickSearchOrders, findQuickSearchShipments } from "@/lib/queries/order-quick-search";
import { normalizeTrackingStatus, normalizedTrackingLabel } from "@/lib/tracking/status";
import { productQuickActions, type QuickSearchAction } from "@/lib/catalog/quick-actions";
import { visibleNavGroups } from "@/lib/navigation/nav-items";
import { visibleReports } from "@/lib/navigation/reports";
import { matchPages, type PageDestination } from "@/lib/navigation/page-search";
import { findReturnParcels, RETURN_PARCEL_STATE_LABELS } from "@/lib/queries/return-receiving";
import { canReadWarehouse } from "@/lib/auth/location-access";

export interface QuickSearchResult {
  id: string;
  type: "customer" | "product" | "order" | "sale" | "supplier" | "return" | "shipment" | "page";
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
    const customerCode = normalizeScannedCustomerCode(trimmed).code;
    const customers = await prisma.customer.findMany({
      where: {
        AND: [
          customerVisibilityWhere(user),
          {
            OR: [
              { fullName: { contains: trimmed, mode: "insensitive" } },
              { phone: { contains: trimmed, mode: "insensitive" } },
              { email: { contains: trimmed, mode: "insensitive" } },
              // Partial / formatted / international phone on the normalized
              // key — same rule as the orders search (« 0612 34 », « +212 6… »).
              ...customerPhoneSearchKeys(trimmed).map((digits) => ({ phoneKey: { contains: digits } })),
              // Customer code « CL-000001 » (docs/adr/0060): exact, scanner-normalised,
              // or its beginning (« CL-0000 ») — a prefix on the (tenantId, barcode) key.
              { barcode: customerCode },
              ...(/^CL-\d+$/.test(customerCode) ? [{ barcode: { startsWith: customerCode } }] : []),
            ],
          },
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
    // Visible order number (tenant prefix), external store number, tracking
    // number (exact first) — src/lib/queries/order-quick-search.ts.
    const { orderNumberPrefix } = await getReportBusinessInfo();
    const orders = await findQuickSearchOrders(trimmed, orderNumberPrefix);
    results.push(
      ...orders.map((o) => ({
        id: o.id,
        type: "order" as const,
        title: displayOrderNumber(o, orderNumberPrefix),
        // The matched tracking number is shown, so the row says why it's here.
        subtitle: o.matchedTrackingNumber ? `${o.customerName} · Suivi ${o.matchedTrackingNumber}` : o.customerName,
        href: `/commandes/${o.id}`,
      }))
    );
  }

  // Shipments (« Expéditions ») by tracking number — the permission of
  // /livraison and /livraison/suivi (`delivery.view`, an ONLINE-domain
  // permission: an Offline-only user never holds it, docs/adr/0039). A parcel
  // whose order is already listed above is not repeated. Carrier + status
  // only — never a cost or an amount.
  if (userHasPermission(user, "delivery.view")) {
    const listedOrderIds = results.filter((r) => r.type === "order").map((r) => r.id);
    const shipments = await findQuickSearchShipments(trimmed, listedOrderIds);
    results.push(
      ...shipments.map((s) => ({
        id: s.id,
        type: "shipment" as const,
        title: s.trackingNumber,
        subtitle: `${s.providerName} · ${normalizedTrackingLabel(normalizeTrackingStatus(s.status, s.providerStatusRaw))}`,
        href: `/livraison/suivi?q=${encodeURIComponent(s.trackingNumber)}`,
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

  // Returned parcels (« Retours colis ») by exact tracking / order number —
  // the workspace's own lookup, the same permission and location rule.
  if (userHasPermission(user, "orders.return")) {
    const parcels = (await findReturnParcels(trimmed)).filter(
      (p) => (p.eligible || p.pendingReception || p.inspectedCount > 0) && (user.locations.global || (p.warehouseId !== null && canReadWarehouse(user, p.warehouseId)))
    );
    results.push(
      ...parcels.slice(0, 5).map((p) => ({
        id: p.shipmentId,
        type: "return" as const,
        title: `Colis retourné ${p.trackingNumber ?? p.orderLabel}`,
        subtitle: `${p.orderLabel} · ${RETURN_PARCEL_STATE_LABELS[p.state]}`,
        href: p.pendingReception
          ? `/livraison/retours/inspection/${p.pendingReception.id}`
          : `/livraison/retours?q=${encodeURIComponent(p.trackingNumber ?? p.orderLabel)}`,
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

  results.push(...searchPages(user, trimmed));
  return results;
}

/**
 * « Pages » — the sidebar destinations and the reports this user may open,
 * by the SAME rules as the sidebar (visibleNavGroups) and /rapports
 * (visibleReports). Never a page the user can't open; each page re-checks
 * on the server anyway.
 */
function searchPages(user: Awaited<ReturnType<typeof requireUserForAction>>, query: string): QuickSearchResult[] {
  const pages: PageDestination[] = visibleNavGroups(user.permissions).flatMap((g) => g.items.map((i) => ({ href: i.href, label: i.label, group: g.label })));
  if (userHasPermission(user, "analytics.view")) {
    for (const r of visibleReports(user)) {
      if (!pages.some((p) => p.href === r.href)) pages.push({ href: r.href, label: r.title, group: "Rapports" });
    }
  }
  return matchPages(pages, query).map((p) => ({ id: p.href, type: "page" as const, title: p.label, subtitle: p.group, href: p.href }));
}
