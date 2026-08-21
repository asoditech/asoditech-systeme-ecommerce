"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { reserveStockForOrder, releaseStockForOrder, fulfillStockForOrder, returnStockForOrder } from "@/lib/inventory";
import {
  createOrderSchema,
  updateOrderStatusSchema,
  updateOrderPaymentStatusSchema,
  cancelOrderSchema,
  createRefundSchema,
  updateRefundStatusSchema,
  canTransitionOrderStatus,
  type CreateOrderInput,
} from "@/lib/validation/order";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { Prisma } from "@prisma/client";
import type { IdResult } from "@/actions/types";

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

  // Resolve product/variation snapshots server-side — never trust client-supplied prices/names.
  const resolvedItems: Prisma.OrderItemCreateManyOrderInput[] = [];
  for (const item of parsed.data.items) {
    if (item.variationId) {
      const variation = await prisma.productVariation.findUnique({
        where: { id: item.variationId },
        include: { product: true },
      });
      if (!variation) return actionError("Une variation sélectionnée est introuvable.");
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

  const subtotal = parsed.data.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const total = subtotal - parsed.data.discountTotal + parsed.data.shippingCost;

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
    newValue: { total: total.toString(), customerId: customer.id },
  });

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

  const order = await prisma.$transaction(async (tx) => {
    const timestampField: Record<string, Date> = {};
    if (parsed.data.status === "CONFIRMEE") timestampField.confirmedAt = new Date();
    if (parsed.data.status === "EXPEDIEE") timestampField.shippedAt = new Date();
    if (parsed.data.status === "LIVREE") timestampField.deliveredAt = new Date();
    if (parsed.data.status === "ANNULEE") timestampField.cancelledAt = new Date();

    const updated = await tx.order.update({
      where: { id: parsed.data.id },
      data: { status: parsed.data.status, ...timestampField },
    });

    if (parsed.data.status === "EXPEDIEE") {
      await fulfillStockForOrder(tx, updated.id, lines, user.id);
    } else if (parsed.data.status === "ANNULEE") {
      if (wasFulfilled) {
        await returnStockForOrder(tx, updated.id, lines, user.id, "Annulation après expédition");
      } else {
        await releaseStockForOrder(tx, updated.id, lines, user.id);
      }
    } else if (parsed.data.status === "RETOUR") {
      await returnStockForOrder(tx, updated.id, lines, user.id, "Retour client");
    }

    return updated;
  });

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

  const order = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: parsed.data.id },
      data: { status: "ANNULEE", cancelledAt: new Date() },
    });
    if (wasFulfilled) {
      await returnStockForOrder(tx, updated.id, lines, user.id, parsed.data.reason ?? "Commande annulée");
    } else {
      await releaseStockForOrder(tx, updated.id, lines, user.id);
    }
    return updated;
  });

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
  if (parsed.data.amount > Number(order.total)) {
    return actionError("Le montant du remboursement dépasse le total de la commande.");
  }

  const refund = await prisma.refund.create({
    data: {
      orderId: parsed.data.orderId,
      amount: parsed.data.amount,
      reason: normalizeOptional(parsed.data.reason),
      processedById: user.id,
    },
  });

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

  const refund = await prisma.$transaction(async (tx) => {
    const updated = await tx.refund.update({ where: { id: parsed.data.id }, data: { status: parsed.data.status } });
    if (parsed.data.status === "COMPLETE") {
      await tx.order.update({ where: { id: updated.orderId }, data: { paymentStatus: "REMBOURSE" } });
    }
    return updated;
  });

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
