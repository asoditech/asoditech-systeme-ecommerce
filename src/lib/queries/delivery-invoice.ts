import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Everything one delivery invoice ("facture de livraison") needs: the
 * shipment, its order + line items + customer shipping snapshot, the
 * carrier, and the tenant's own business-settings header. Tenant-scoped
 * automatically through `prisma`. Returns `null` when the shipment does
 * not exist (or belongs to another tenant).
 */
export async function getDeliveryInvoiceData(shipmentId: string) {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: {
      provider: { select: { name: true } },
      order: {
        select: {
          orderNumber: true,
          displayNumber: true,
          externalNumber: true,
          source: true,
          placedAt: true,
          currency: true,
          subtotal: true,
          discountTotal: true,
          shippingCost: true,
          total: true,
          paymentMethod: true,
          paymentStatus: true,
          notes: true,
          shippingAddressLine1: true,
          shippingAddressLine2: true,
          shippingCity: true,
          shippingRegion: true,
          shippingCountry: true,
          shippingPhone: true,
          customer: { select: { fullName: true, phone: true, email: true } },
          items: {
            select: {
              nameSnapshot: true,
              skuSnapshot: true,
              quantity: true,
              unitPrice: true,
              discount: true,
              total: true,
            },
          },
        },
      },
    },
  });
  if (!shipment) return null;

  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: shipment.tenantId },
    update: {},
    create: {},
  });

  return { shipment, settings };
}

/** Recent shipments for the invoice picker — most recent first. */
export async function listInvoiceableShipments(limit = 100) {
  return prisma.shipment.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      trackingNumber: true,
      createdAt: true,
      cost: true,
      provider: { select: { name: true } },
      order: {
        select: {
          displayNumber: true,
          orderNumber: true,
          source: true,
          externalNumber: true,
          total: true,
          currency: true,
          shippingCity: true,
          customer: { select: { fullName: true } },
        },
      },
    },
  });
}
