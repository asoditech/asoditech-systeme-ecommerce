import "server-only";

import { prisma } from "@/lib/prisma";
import "@/lib/integrations/delivery/providers"; // populates the registry — see that module's own doc comment
import { listDeliveryProviders } from "@/lib/integrations/delivery/registry";
import type { Prisma, ShipmentStatus } from "@prisma/client";

const PAGE_SIZE = 25;

export async function listShippingProviders() {
  return prisma.shippingProvider.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { shipments: true } } } });
}

export async function listShipments(params: { status?: ShipmentStatus; providerId?: string; page?: number }) {
  const page = Math.max(1, params.page ?? 1);
  const where: Prisma.ShipmentWhereInput = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.providerId ? { providerId: params.providerId } : {}),
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

export async function getDeliveryStats() {
  const [total, delivered, failed, inTransit] = await Promise.all([
    prisma.shipment.count(),
    prisma.shipment.count({ where: { status: "LIVRE" } }),
    prisma.shipment.count({ where: { status: "ECHEC" } }),
    prisma.shipment.count({ where: { status: "EN_TRANSIT" } }),
  ]);
  return {
    total,
    delivered,
    failed,
    inTransit,
    successRate: total > 0 ? delivered / total : null,
  };
}

/** Orders confirmed/preparing that don't have a shipment yet — need one created. */
export async function listOrdersAwaitingShipment() {
  return prisma.order.findMany({
    where: {
      status: { in: ["CONFIRMEE", "EN_PREPARATION"] },
      shipments: { none: {} },
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
 * docs/adr/0012-delivery-provider-integration.md). Empty in production
 * today; see src/lib/integrations/delivery/providers/index.ts.
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
