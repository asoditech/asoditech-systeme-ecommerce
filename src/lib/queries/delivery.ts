import "server-only";

import { prisma } from "@/lib/prisma";
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
