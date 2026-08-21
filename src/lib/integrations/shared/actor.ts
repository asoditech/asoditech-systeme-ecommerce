import "server-only";

import type { AuditActorType } from "@prisma/client";

/**
 * Who initiated a sync/import operation — a real logged-in user clicking
 * "Synchroniser", or a webhook receiver acting with no session. Threaded
 * through every sync/import function (both WooCommerce and Shopify) so
 * audit events and inventory movements attribute correctly. See
 * docs/adr/0010-woocommerce-integration.md and
 * docs/adr/0011-shopify-integration.md.
 */
export type SyncActor = { type: "USER"; userId: string } | { type: "INTEGRATION" };

export function actorAuditFields(actor: SyncActor): { actorType: AuditActorType; actorUserId: string | null } {
  return actor.type === "USER"
    ? { actorType: "USER", actorUserId: actor.userId }
    : { actorType: "INTEGRATION", actorUserId: null };
}

export function actorPerformedById(actor: SyncActor): string | null {
  return actor.type === "USER" ? actor.userId : null;
}
