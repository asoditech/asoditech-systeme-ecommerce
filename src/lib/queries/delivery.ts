import "server-only";

import { prisma } from "@/lib/prisma";
import "@/lib/integrations/delivery/providers"; // populates the registry — see that module's own doc comment
import { listDeliveryProviders } from "@/lib/integrations/delivery/registry";
import { SHIPPABLE_ORDER_STATUSES, ACTIVE_SHIPMENT_STATUSES } from "@/lib/delivery";
import type { Prisma, ShipmentStatus } from "@prisma/client";

const PAGE_SIZE = 25;

export async function listShippingProviders() {
  return prisma.shippingProvider.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { shipments: true } } } });
}

export async function listShipments(params: {
  status?: ShipmentStatus;
  providerId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
}) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.ShipmentWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.providerId ? { providerId: params.providerId } : {}),
    ...(params.dateFrom || params.dateTo
      ? {
          createdAt: {
            ...(params.dateFrom ? { gte: params.dateFrom } : {}),
            ...(params.dateTo ? { lte: params.dateTo } : {}),
          },
        }
      : {}),
  };

  const [shipments, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { order: { include: { customer: true } }, provider: true },
    }),
    prisma.shipment.count({ where }),
  ]);

  return { shipments, total, page, pageSize: PAGE_SIZE };
}

export async function getDeliveryStats(dateFrom?: Date, dateTo?: Date) {
  const dateFilter: Prisma.ShipmentWhereInput =
    dateFrom || dateTo
      ? { createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
      : {};

  const [total, delivered, failed, inTransit] = await Promise.all([
    prisma.shipment.count({ where: dateFilter }),
    prisma.shipment.count({ where: { ...dateFilter, status: "LIVRE" } }),
    prisma.shipment.count({ where: { ...dateFilter, status: "ECHEC" } }),
    prisma.shipment.count({ where: { ...dateFilter, status: "EN_TRANSIT" } }),
  ]);
  return {
    total,
    delivered,
    failed,
    inTransit,
    successRate: total > 0 ? delivered / total : null,
  };
}

/**
 * API-created shipments still EN_ATTENTE and not yet on a delivery note —
 * the candidates for a new Bon de Livraison. See
 * docs/adr/0015-delivery-manifest.md.
 */
export async function listManifestableShipments() {
  return prisma.shipment.findMany({
    where: {
      status: "EN_ATTENTE",
      manifestId: null,
      externalId: { not: null },
      provider: { type: "API" },
    },
    include: { order: { include: { customer: true } }, provider: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Delivery notes / manifests, newest first, with their provider + parcel count. */
export async function listDeliveryManifests() {
  return prisma.deliveryManifest.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { provider: true, _count: { select: { shipments: true } } },
  });
}

/**
 * Orders that still need a shipment created — i.e. exactly the orders
 * `createShipmentAction`/`createShipmentViaProviderAction` would accept
 * right now. Deliberately not "no shipment row at all": an order whose
 * only shipment attempt already failed (status ECHEC — no external
 * parcel, e.g. from an unresolved delivery-provider city) still needs
 * one, and must keep showing up here for the operator to retry — see
 * docs/adr/0013-ozonexpress-integration.md (Phase 27B fix; this powers
 * the "À expédier" tab). Only a genuinely live shipment
 * (ACTIVE_SHIPMENT_STATUSES) with any provider excludes an order.
 */
export async function listOrdersAwaitingShipment() {
  return prisma.order.findMany({
    where: {
      status: { in: SHIPPABLE_ORDER_STATUSES },
      shipments: { none: { status: { in: ACTIVE_SHIPMENT_STATUSES } } },
    },
    include: { customer: true },
    orderBy: { createdAt: "asc" },
    take: 25,
  });
}

/**
 * Serializable summary of the delivery-provider adapters actually
 * registered on this deployment (never the full adapter object, which
 * carries functions and can't cross the Server -> Client boundary — see
 * docs/adr/0012-delivery-provider-integration.md). Populated from
 * src/lib/integrations/delivery/providers/index.ts (currently: OzonExpress).
 */
export interface AvailableDeliveryConnector {
  key: string;
  displayName: string;
  capabilities: string[];
  /** Typed credential inputs for the "Configurer" form. Empty → the raw
   * JSON credential editor is shown instead. */
  credentialFields: { name: string; label: string; type: "text" | "password"; required: boolean; help?: string }[];
}

export function listAvailableDeliveryConnectors(): AvailableDeliveryConnector[] {
  return listDeliveryProviders().map((adapter) => ({
    key: adapter.key,
    displayName: adapter.displayName,
    capabilities: [...adapter.capabilities],
    credentialFields: adapter.credentialFields ? adapter.credentialFields.map((f) => ({ ...f })) : [],
  }));
}
