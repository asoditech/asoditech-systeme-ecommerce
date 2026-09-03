"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import {
  reserveStockForOrder,
  releaseStockForOrder,
  fulfillStockForOrder,
  returnStockForOrder,
  getDefaultWarehouseId,
  InsufficientStockError,
} from "@/lib/inventory";
import {
  notifyNewOrder,
  notifyOrderReturned,
  notifyPaymentProblem,
  checkAndNotifyLowStock,
} from "@/lib/notifications";
import {
  createOrderSchema,
  updateOrderStatusSchema,
  updateOrderPaymentStatusSchema,
  cancelOrderSchema,
  createRefundSchema,
  updateRefundStatusSchema,
  canTransitionOrderStatus,
  canTransitionRefundStatus,
  type CreateOrderInput,
} from "@/lib/validation/order";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { Prisma } from "@prisma/client";
import type { IdResult } from "@/actions/types";

/** Thrown when a conditional status-transition update matches 0 rows — see updateOrderStatusAction. */
class OrderConflictError extends Error {}

/** Thrown when a refund would push the order's total refunded amount past its total. */
class RefundLimitError extends Error {}

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function searchCustomersForOrderAction(query: string) {
  await requirePermissionForAction("orders.create");
  if (query.trim().length < 2) return [];
  return prisma.customer.findMany({
    where: {
      OR: [
        { fullName: { contains: query, mode: "insensitive" } },
        { phone: { contains: query, mode: "insensitive" } },
      ],
    },
    take: 8,
  });
}

export async function searchProductsForOrderAction(query: string) {
  await requirePermissionForAction("orders.create");
  if (query.trim().length < 2) return [];
  const products = await prisma.product.findMany({
    where: {
      status: "ACTIF",
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { sku: { contains: query, mode: "insensitive" } },
      ],
    },
    include: { variations: true },
    take: 8,
  });

  // Decimal fields aren't serializable across the Server Action boundary —
  // convert to plain strings before returning to the client component.
  return products.map((p) => ({
    ...p,
    price: p.price.toString(),
    salePrice: p.salePrice?.toString() ?? null,
    cost: p.cost?.toString() ?? null,
    variations: p.variations.map((v) => ({
      ...v,
      price: v.price?.toString() ?? null,
      cost: v.cost?.toString() ?? null,
    })),
  }));
}

export async function createOrderAction(input: CreateOrderInput): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.create");

  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const customer = await prisma.customer.findUnique({ where: { id: parsed.data.customerId } });
  if (!customer) {
    return actionError("Client introuvable.");
  }

  // Fulfilment warehouse (Phase 32b — see docs/adr/0020-stock-transfers.md).
  // A client-supplied override is validated (must exist and be active — an
  // operator may legitimately fulfil from an active MAGASIN for a walk-in
  // order); the default is trusted verbatim. `null` (broken deployment
  // with no default warehouse) is stored as-is and the pre-32b
  // compatibility resolution then applies.
  const overrideWarehouseId =
    parsed.data.fulfillmentWarehouseId && parsed.data.fulfillmentWarehouseId.length > 0
      ? parsed.data.fulfillmentWarehouseId
      : null;
  let fulfillmentWarehouseId: string | null;
  if (overrideWarehouseId) {
    const warehouse = await prisma.warehouse.findUnique({ where: { id: overrideWarehouseId } });
    if (!warehouse || !warehouse.isActive) {
      return actionError("Entrepôt de préparation invalide.");
    }
    fulfillmentWarehouseId = warehouse.id;
  } else {
    fulfillmentWarehouseId = await getDefaultWarehouseId();
  }

  // Resolve product/variation snapshots server-side — never trust client-supplied prices/names.
  const resolvedItems: Prisma.OrderItemCreateManyOrderInput[] = [];
  for (const item of parsed.data.items) {
    if (item.variationId) {
      const variation = await prisma.productVariation.findUnique({
        where: { id: item.variationId },
        include: { product: true },
      });
      if (!variation) return actionError("Une variation sélectionnée est introuvable.");
      // The search-assisted UI only ever offers ACTIF products (see
      // searchProductsForOrderAction above), but createOrderAction is the
      // real authority boundary — a crafted request supplying a
      // brouillon/archived product's ID directly must be rejected here too,
      // not just filtered out of the search results. Found during the A–G
      // audit; see docs/adr/0002-domain-model.md's audit addendum.
      if (variation.product.status !== "ACTIF") {
        return actionError("Ce produit n'est plus disponible à la vente.");
      }
      resolvedItems.push({
        productId: variation.productId,
        variationId: variation.id,
        nameSnapshot: variation.product.name,
        skuSnapshot: variation.sku,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discount: item.discount,
        total: item.unitPrice * item.quantity - item.discount,
        costSnapshot: variation.cost ?? variation.product.cost ?? null,
      });
    } else if (item.productId) {
      const product = await prisma.product.findUnique({ where: { id: item.productId } });
      if (!product) return actionError("Un produit sélectionné est introuvable.");
      if (product.status !== "ACTIF") {
        return actionError("Ce produit n'est plus disponible à la vente.");
      }
      resolvedItems.push({
        productId: product.id,
        variationId: null,
        nameSnapshot: product.name,
        skuSnapshot: product.sku,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        discount: item.discount,
        total: item.unitPrice * item.quantity - item.discount,
        costSnapshot: product.cost ?? null,
      });
    } else {
      return actionError("Chaque article doit référencer un produit.");
    }
  }

  // subtotal is the gross line total (before any discount) — conventional
  // e-commerce terminology, and what's displayed as "Sous-total". `total`
  // must net out BOTH each line's own discount AND the order-level
  // discountTotal field, or it silently disagrees with what staff saw in
  // the order form (which does net out per-line discounts) — see the A–G
  // audit's finance-integrity findings, docs/adr/0007-finance-and-profit.md.
  const subtotal = parsed.data.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const itemsDiscountTotal = parsed.data.items.reduce((sum, i) => sum + i.discount, 0);
  const total = subtotal - itemsDiscountTotal - parsed.data.discountTotal + parsed.data.shippingCost;

  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        customerId: parsed.data.customerId,
        paymentMethod: parsed.data.paymentMethod,
        shippingCost: parsed.data.shippingCost,
        discountTotal: parsed.data.discountTotal,
        subtotal,
        total,
        currency: parsed.data.currency,
        notes: normalizeOptional(parsed.data.notes),
        internalNotes: normalizeOptional(parsed.data.internalNotes),
        shippingAddressLine1: normalizeOptional(parsed.data.shippingAddressLine1),
        shippingAddressLine2: normalizeOptional(parsed.data.shippingAddressLine2),
        shippingCity: normalizeOptional(parsed.data.shippingCity),
        shippingRegion: normalizeOptional(parsed.data.shippingRegion),
        shippingCountry: normalizeOptional(parsed.data.shippingCountry),
        shippingPhone: normalizeOptional(parsed.data.shippingPhone),
        fulfillmentWarehouseId,
        createdById: user.id,
        items: { create: resolvedItems },
      },
    });

    await reserveStockForOrder(
      tx,
      created.id,
      resolvedItems.map((i) => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity })),
      user.id
    );

    return created;
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.created",
    entityType: "Order",
    entityId: order.id,
    newValue: { total: total.toString(), customerId: customer.id, fulfillmentWarehouseId },
  });

  await notifyNewOrder(
    {
      id: order.id,
      orderNumber: order.orderNumber,
      total: total,
      currency: parsed.data.currency,
      customerName: customer.fullName,
      source: "INTERNE",
    },
    user.id
  );

  revalidatePath("/commandes");
  return actionOk({ id: order.id });
}

export async function updateOrderStatusAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.edit");

  const parsed = updateOrderStatusSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
    note: formData.get("note"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.order.findUnique({ where: { id: parsed.data.id }, include: { items: true } });
  if (!existing) return actionError("Commande introuvable.");

  if (!canTransitionOrderStatus(existing.status, parsed.data.status)) {
    return actionError(`Transition de statut invalide : ${existing.status} → ${parsed.data.status}.`);
  }

  const lines = existing.items.map((i) => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity }));
  const wasFulfilled = existing.shippedAt !== null;

  let order;
  try {
    order = await prisma.$transaction(async (tx) => {
      const timestampField: Record<string, Date> = {};
      if (parsed.data.status === "CONFIRMEE") timestampField.confirmedAt = new Date();
      if (parsed.data.status === "EXPEDIEE") timestampField.shippedAt = new Date();
      if (parsed.data.status === "LIVREE") timestampField.deliveredAt = new Date();
      if (parsed.data.status === "ANNULEE") timestampField.cancelledAt = new Date();

      // Conditional update (WHERE ... AND status = <the status we validated
      // the transition from>) instead of a blind update: this is what
      // actually closes the race where two concurrent requests both read
      // the same starting status, both pass canTransitionOrderStatus, and
      // would otherwise both apply their stock side effects. Postgres locks
      // the row for the first UPDATE; the second re-evaluates the WHERE
      // clause against the now-committed row and matches 0 rows, so
      // `count` below is the real concurrency guard, not just an audit
      // nicety. See docs/adr/0002-domain-model.md's audit addendum.
      const result = await tx.order.updateMany({
        where: { id: parsed.data.id, status: existing.status },
        data: { status: parsed.data.status, ...timestampField },
      });
      if (result.count === 0) {
        throw new OrderConflictError();
      }

      if (parsed.data.status === "EXPEDIEE") {
        await fulfillStockForOrder(tx, parsed.data.id, lines, user.id);
      } else if (parsed.data.status === "ANNULEE") {
        if (wasFulfilled) {
          await returnStockForOrder(tx, parsed.data.id, lines, user.id, "Annulation après expédition");
        } else {
          await releaseStockForOrder(tx, parsed.data.id, lines, user.id);
        }
      } else if (parsed.data.status === "RETOUR") {
        await returnStockForOrder(tx, parsed.data.id, lines, user.id, "Retour client");
      }

      return tx.order.findUniqueOrThrow({ where: { id: parsed.data.id } });
    });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return actionError(error.message);
    }
    if (error instanceof OrderConflictError) {
      return actionError(
        "Cette commande a été modifiée entre-temps par une autre action. Rechargez la page et réessayez."
      );
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.status_changed",
    entityType: "Order",
    entityId: order.id,
    previousValue: { status: existing.status },
    newValue: { status: order.status },
    metadata: parsed.data.note ? { note: parsed.data.note } : undefined,
  });

  if (parsed.data.status === "EXPEDIEE") {
    // Fulfillment just reduced on-hand stock — surface anything now low.
    await checkAndNotifyLowStock(
      { productIds: lines.map((l) => l.productId), variationIds: lines.map((l) => l.variationId) },
      user.id
    );
  } else if (parsed.data.status === "RETOUR") {
    const customer = await prisma.customer.findUnique({ where: { id: existing.customerId }, select: { fullName: true } });
    await notifyOrderReturned(
      { id: order.id, orderNumber: order.orderNumber, customerName: customer?.fullName ?? "Client" },
      user.id
    );
  }

  revalidatePath("/commandes");
  revalidatePath(`/commandes/${order.id}`);
  return actionOk({ id: order.id });
}

export async function updateOrderPaymentStatusAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.edit");

  const parsed = updateOrderPaymentStatusSchema.safeParse({
    id: formData.get("id"),
    paymentStatus: formData.get("paymentStatus"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  // REMBOURSE is a derived status, set only by updateRefundStatusAction
  // when a Refund actually reaches COMPLETE. Allowing it here would let
  // anyone with orders.edit (e.g. SALES) mark an order refunded without
  // ever creating a Refund row — bypassing that action's orders.refund
  // permission gate and its amount-vs-order-total validation entirely.
  // Found during the A–G audit; see docs/adr/0003-auth-and-rbac.md.
  if (parsed.data.paymentStatus === "REMBOURSE") {
    return actionError(
      "Le statut « Remboursé » ne peut être défini que via un remboursement complété."
    );
  }

  const existing = await prisma.order.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Commande introuvable.");

  const order = await prisma.order.update({
    where: { id: parsed.data.id },
    data: { paymentStatus: parsed.data.paymentStatus },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.updated",
    entityType: "Order",
    entityId: order.id,
    previousValue: { paymentStatus: existing.paymentStatus },
    newValue: { paymentStatus: order.paymentStatus },
  });

  if (order.paymentStatus === "ECHEC" && existing.paymentStatus !== "ECHEC") {
    await notifyPaymentProblem({ id: order.id, orderNumber: order.orderNumber }, user.id);
  }

  revalidatePath(`/commandes/${order.id}`);
  return actionOk({ id: order.id });
}

export async function cancelOrderAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.cancel");

  const parsed = cancelOrderSchema.safeParse({
    id: formData.get("id"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.order.findUnique({ where: { id: parsed.data.id }, include: { items: true } });
  if (!existing) return actionError("Commande introuvable.");
  if (!canTransitionOrderStatus(existing.status, "ANNULEE")) {
    return actionError("Cette commande ne peut plus être annulée dans son statut actuel.");
  }

  const lines = existing.items.map((i) => ({ productId: i.productId, variationId: i.variationId, quantity: i.quantity }));
  const wasFulfilled = existing.shippedAt !== null;

  let order;
  try {
    order = await prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: parsed.data.id, status: existing.status },
        data: { status: "ANNULEE", cancelledAt: new Date() },
      });
      if (result.count === 0) {
        throw new OrderConflictError();
      }
      if (wasFulfilled) {
        await returnStockForOrder(tx, parsed.data.id, lines, user.id, parsed.data.reason ?? "Commande annulée");
      } else {
        await releaseStockForOrder(tx, parsed.data.id, lines, user.id);
      }
      return tx.order.findUniqueOrThrow({ where: { id: parsed.data.id } });
    });
  } catch (error) {
    if (error instanceof OrderConflictError) {
      return actionError(
        "Cette commande a été modifiée entre-temps par une autre action. Rechargez la page et réessayez."
      );
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.cancelled",
    entityType: "Order",
    entityId: order.id,
    previousValue: { status: existing.status },
    newValue: { status: "ANNULEE" },
    metadata: parsed.data.reason ? { reason: parsed.data.reason } : undefined,
  });

  revalidatePath("/commandes");
  revalidatePath(`/commandes/${order.id}`);
  return actionOk({ id: order.id });
}

export async function createRefundAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.refund");

  const parsed = createRefundSchema.safeParse({
    orderId: formData.get("orderId"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order) return actionError("Commande introuvable.");

  let refund;
  try {
    refund = await prisma.$transaction(async (tx) => {
      // Row-level lock on the order, held until this transaction commits —
      // without it, two concurrent createRefundAction calls for the same
      // order (a double-click, or two staff refunding at once) can each
      // read the same pre-refund aggregate below, each individually pass
      // the cap check, and both insert — jointly refunding past the order
      // total. Order status/Shipment status transitions close their own
      // version of this race with a conditional `updateMany` + row count,
      // but that pattern only applies to an UPDATE; this is an INSERT
      // gated by an aggregate over a different table, so it needs an
      // actual lock. Prisma has no pessimistic-locking API, so this is a
      // deliberate, narrowly-scoped raw query rather than new ORM surface.
      // Found during the Phase 26 structural audit; see
      // docs/adr/0007-finance-and-profit.md.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${parsed.data.orderId} FOR UPDATE`;

      // Cap against the order total MINUS every refund already committed
      // or in flight for it (EN_ATTENTE/APPROUVE/COMPLETE — everything
      // except REJETE), not just the order total alone — otherwise two
      // refunds that each individually fit under the total can together
      // exceed it. Found during the A–G audit; see
      // docs/adr/0007-finance-and-profit.md.
      const existingRefunds = await tx.refund.aggregate({
        where: { orderId: parsed.data.orderId, status: { not: "REJETE" } },
        _sum: { amount: true },
      });
      const alreadyCommitted = Number(existingRefunds._sum.amount ?? 0);
      const remaining = Number(order.total) - alreadyCommitted;
      if (parsed.data.amount > remaining) {
        throw new RefundLimitError(
          remaining > 0
            ? `Le montant dépasse le solde remboursable (${remaining.toFixed(2)} MAD restants).`
            : "Cette commande a déjà été intégralement remboursée."
        );
      }

      return tx.refund.create({
        data: {
          orderId: parsed.data.orderId,
          amount: parsed.data.amount,
          reason: normalizeOptional(parsed.data.reason),
          processedById: user.id,
        },
      });
    });
  } catch (error) {
    if (error instanceof RefundLimitError) return actionError(error.message);
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.refund.created",
    entityType: "Order",
    entityId: order.id,
    newValue: { amount: refund.amount.toString() },
  });

  revalidatePath(`/commandes/${order.id}`);
  return actionOk({ id: refund.id });
}

export async function updateRefundStatusAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("orders.refund");

  const parsed = updateRefundStatusSchema.safeParse({
    id: formData.get("id"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.refund.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Remboursement introuvable.");

  if (!canTransitionRefundStatus(existing.status, parsed.data.status)) {
    return actionError(`Transition de statut invalide : ${existing.status} → ${parsed.data.status}.`);
  }

  let refund;
  try {
    refund = await prisma.$transaction(async (tx) => {
      const result = await tx.refund.updateMany({
        where: { id: parsed.data.id, status: existing.status },
        data: { status: parsed.data.status },
      });
      if (result.count === 0) {
        throw new OrderConflictError();
      }
      if (parsed.data.status === "COMPLETE") {
        await tx.order.update({ where: { id: existing.orderId }, data: { paymentStatus: "REMBOURSE" } });
      }
      return tx.refund.findUniqueOrThrow({ where: { id: parsed.data.id } });
    });
  } catch (error) {
    if (error instanceof OrderConflictError) {
      return actionError("Ce remboursement a été modifié entre-temps. Rechargez la page et réessayez.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.refund.status_changed",
    entityType: "Order",
    entityId: refund.orderId,
    previousValue: { status: existing.status },
    newValue: { status: refund.status },
  });

  revalidatePath(`/commandes/${refund.orderId}`);
  return actionOk({ id: refund.id });
}
