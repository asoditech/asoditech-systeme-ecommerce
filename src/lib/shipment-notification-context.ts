import "server-only";
import { prisma } from "@/lib/prisma";

/** Loads the order number + provider name a shipment-failed notification needs. */
export async function shipmentNotificationContext(shipmentId: string) {
  const s = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    select: {
      id: true,
      orderId: true,
      failedReason: true,
      order: { select: { orderNumber: true, displayNumber: true } },
      provider: { select: { name: true } },
    },
  });
  return s
    ? {
        id: s.id,
        orderId: s.orderId,
        orderNumber: s.order.orderNumber,
        orderDisplayNumber: s.order.displayNumber,
        providerName: s.provider.name,
        reason: s.failedReason,
      }
    : null;
}
