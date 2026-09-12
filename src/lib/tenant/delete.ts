import "server-only";

import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { BOOTSTRAP_TENANT_ID } from "@/lib/tenant/resolve";
import { BACKUP_MODELS } from "@/lib/backup/models";

/**
 * Full, irreversible tenant deletion — the destructive counterpart to
 * `/platform`'s create/activate/suspend lifecycle (docs/adr/0027) and to
 * the Backup & Portability module's tenant-scoped wipe (docs/adr/0034,
 * src/lib/backup/import.ts). Unlike a restore's wipe, this clears EVERY
 * tenant-owned row — including the ones a restore deliberately preserves
 * (`User`, `BusinessSettings`, `AuditEvent`) — and then the `tenants` row
 * itself.
 *
 * Ordering: `BACKUP_MODELS` is already the tenant's business-data
 * dependency graph in parent-first INSERT order (see that module's own doc
 * comment — every model's FK points only at an earlier entry); reversing it
 * is the exact same trick `restoreTenantBackup` uses to wipe "replace"
 * models, just applied to every entry instead of a strategy-filtered
 * subset, since a deletion (unlike a restore) doesn't need to preserve
 * anything.
 *
 * `BACKUP_MODELS` deliberately excludes tables that aren't part of a
 * tenant's own portable business data — sessions, tokens, and the
 * platform/commercial bookkeeping tables (docs/adr/0034 "what a backup
 * contains"). Most of those cascade automatically once their real parent
 * row is gone (a `Session`/`Notification`/`PasswordResetToken`/
 * `GoogleOAuthState` row when its `User` is deleted; a `SyncRun`/
 * `WebhookEvent` row when its `Integration` is deleted; a
 * `ShipmentWebhookEvent` row when its `ShippingProvider` is deleted — see
 * prisma/schema.prisma). The handful that carry only a `Restrict` FK to
 * `Tenant` (nothing else references them) do not, and must be cleared
 * explicitly before the `tenants` row itself — `PLATFORM_ONLY_ACCESSORS`
 * below.
 */

export class BootstrapTenantDeletionError extends Error {
  constructor() {
    super("Le tenant d'amorçage ne peut pas être supprimé.");
    this.name = "BootstrapTenantDeletionError";
  }
}

export class TenantNotFoundError extends Error {
  constructor(tenantId: string) {
    super(`Tenant introuvable : ${tenantId}.`);
    this.name = "TenantNotFoundError";
  }
}

// Reverse of BACKUP_MODELS' parent-first insert order = child-first delete
// order, covering every business-data table regardless of restore strategy
// (a deletion wipes User/BusinessSettings/AuditEvent too, unlike a restore).
const BUSINESS_ACCESSORS_DELETE_ORDER: readonly string[] = [...BACKUP_MODELS].reverse().map((m) => m.accessor);

// Platform/commercial tables that carry a `Restrict` FK straight to
// `Tenant` and are never cascade-cleared by deleting anything else (nothing
// else references them — see the module doc comment). Order among
// themselves doesn't matter: none depends on another.
const PLATFORM_ONLY_ACCESSORS: readonly string[] = [
  "tenantSubscription",
  "usageAlertState",
  "invitation",
  "supportTicket",
  "backupRun",
  "googleDriveConnection",
];

type DeleteManyDelegate = { deleteMany: (args?: { where?: unknown }) => Promise<{ count: number }> };

function delegateOf(tx: PrismaTransactionClient, accessor: string): DeleteManyDelegate {
  return (tx as unknown as Record<string, DeleteManyDelegate>)[accessor];
}

export interface DeleteTenantResult {
  tenantId: string;
  slug: string;
  /** Rows removed per table accessor (business tables + the explicit
   * platform-only ones) — does not include rows removed only via a DB-level
   * cascade (sessions, notifications, tokens, sync/webhook logs). */
  deletedCounts: Record<string, number>;
  totalDeleted: number;
}

/**
 * Deletes a tenant and every row it owns, transactionally: either the whole
 * tenant is gone, or (on any error, including an unanticipated FK we don't
 * already know about) nothing is. Refuses the bootstrap tenant outright —
 * callers should still check this themselves for a fast, friendly error
 * before doing any other work, but this is the hard backstop.
 */
export async function deleteTenantData(tenantId: string): Promise<DeleteTenantResult> {
  if (tenantId === BOOTSTRAP_TENANT_ID) {
    throw new BootstrapTenantDeletionError();
  }

  return runWithTenant(tenantId, "platform:delete-tenant", () =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true, slug: true } });
        if (!existing) throw new TenantNotFoundError(tenantId);

        const deletedCounts: Record<string, number> = {};
        let totalDeleted = 0;

        for (const accessor of PLATFORM_ONLY_ACCESSORS) {
          const { count } = await delegateOf(tx, accessor).deleteMany({});
          deletedCounts[accessor] = count;
          totalDeleted += count;
        }

        for (const accessor of BUSINESS_ACCESSORS_DELETE_ORDER) {
          const { count } = await delegateOf(tx, accessor).deleteMany({});
          deletedCounts[accessor] = count;
          totalDeleted += count;
        }

        await tx.tenant.delete({ where: { id: tenantId } });

        return { tenantId, slug: existing.slug, deletedCounts, totalDeleted };
      },
      { maxWait: 15_000, timeout: 120_000 }
    )
  );
}
