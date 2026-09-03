import "server-only";

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { AuditActorType, Prisma } from "@prisma/client";

/**
 * Actions are namespaced "entity.verb" strings. Keep this list in sync with
 * actual call sites so audit queries/filters stay predictable instead of
 * accumulating ad-hoc strings.
 */
export type AuditAction =
  | "user.login.success"
  | "user.login.failure"
  | "user.logout"
  | "user.created"
  | "user.role_changed"
  | "user.status_changed"
  | "customer.created"
  | "customer.updated"
  | "customer.address.created"
  | "customer.address.updated"
  | "customer.address.deleted"
  | "product.created"
  | "product.updated"
  | "product.archived"
  | "category.created"
  | "category.updated"
  | "order.created"
  | "order.updated"
  | "order.status_changed"
  | "order.cancelled"
  | "order.refund.created"
  | "order.refund.status_changed"
  | "inventory.adjusted"
  | "inventory.reconciled"
  | "warehouse.created"
  | "warehouse.updated"
  | "warehouse.activated"
  | "warehouse.deactivated"
  | "stock_transfer.created"
  | "stock_transfer.dispatched"
  | "stock_transfer.received"
  | "stock_transfer.cancelled"
  | "shipment.created"
  | "shipment.creation_failed"
  | "shipment.status_changed"
  | "shipment.status_sync_failed"
  | "shipment.cancelled"
  | "shipment.cancellation_failed"
  | "shipment.webhook_received"
  | "shipment.webhook_rejected"
  | "delivery_manifest.created"
  | "delivery_manifest.failed"
  | "delivery_city_mapping.created"
  | "delivery_city_mapping.updated"
  | "delivery_city_mapping.deleted"
  | "shipping_provider.created"
  | "shipping_provider.updated"
  | "shipping_provider.deleted"
  | "shipping_provider.api_configured"
  | "shipping_provider.connection_test_succeeded"
  | "shipping_provider.connection_test_failed"
  | "expense.created"
  | "expense.updated"
  | "expense_category.created"
  | "marketing_channel.created"
  | "marketing_campaign.created"
  | "marketing_campaign.updated"
  | "integration.connected"
  | "integration.disconnected"
  | "integration.updated"
  | "integration.connection_test_succeeded"
  | "integration.connection_test_failed"
  | "integration.sync_started"
  | "integration.sync_completed"
  | "integration.sync_partial_failure"
  | "integration.webhook_received"
  | "integration.webhook_rejected"
  | "settings.updated"
  | "ai.query";

interface RecordAuditEventInput {
  actorType: AuditActorType;
  actorUserId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  previousValue?: Prisma.InputJsonValue;
  newValue?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append-only audit trail. Never call `prisma.auditEvent.update` or
 * `.delete` anywhere in the app — this function is the only writer.
 * Callers must not pass secrets, tokens, or password material.
 */
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  let ipAddress: string | null = null;
  let userAgent: string | null = null;
  try {
    const hdrs = await headers();
    ipAddress = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ?? null;
    userAgent = hdrs.get("user-agent")?.slice(0, 255) ?? null;
  } catch {
    // headers() throws outside a request scope (e.g. background jobs, seed
    // scripts) — audit events from those contexts simply omit IP/UA.
  }

  await prisma.auditEvent.create({
    data: {
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      previousValue: input.previousValue ?? undefined,
      newValue: input.newValue ?? undefined,
      metadata: input.metadata ?? undefined,
      ipAddress,
      userAgent,
    },
  });
}
