import "server-only";

import { Prisma } from "@prisma/client";
import { prisma, prismaBase, type PrismaTransactionClient } from "@/lib/prisma";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
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

/** Trial purge only (docs/adr/0053): a regular customer can never be purged by this path. */
export class TenantNotPurgeableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TenantNotPurgeableError";
  }
}

/** Thrown INSIDE the transaction when a tenant-owned row survived — the whole purge rolls back. */
export class TenantPurgeVerificationError extends Error {
  constructor(public readonly remaining: Record<string, number>) {
    super(`Purge incomplète — données restantes : ${Object.entries(remaining).map(([m, n]) => `${m}=${n}`).join(", ")}.`);
    this.name = "TenantPurgeVerificationError";
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

// Per-user access configuration (docs/adr/0037, 0038, 0039). Not part of a backup,
// and it must go BEFORE the business tables: a UserLocation RESTRICTS the delete of
// its Warehouse (which precedes User in the child-first order below).
const ACCESS_CONFIG_ACCESSORS: readonly string[] = ["userLocation", "userChannel", "userPermissionOverride"];

// Physical Online-order returns are not part of a backup, and neither
// cascades from anything deleted earlier: an OrderReturn RESTRICTS its Order's
// delete and an OrderReturnLine RESTRICTS its Warehouse's — so a tenant with a
// single return could not be deleted at all (docs/adr/0053). Lines first.
const ORDER_RETURN_ACCESSORS: readonly string[] = ["orderReturnLine", "orderReturn"];

/** Every model carrying `tenantId` — the purge's dry-run AND its zero-row proof, from the schema itself. */
const TENANT_MODEL_ACCESSORS: readonly string[] = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === "tenantId"))
  .map((m) => m.name[0].toLowerCase() + m.name.slice(1));

type CountDelegate = { count: (args?: { where?: unknown }) => Promise<number> };

type DeleteManyDelegate = { deleteMany: (args?: { where?: unknown }) => Promise<{ count: number }> };

function delegateOf(tx: PrismaTransactionClient, accessor: string): DeleteManyDelegate {
  return (tx as unknown as Record<string, DeleteManyDelegate>)[accessor];
}

/**
 * Whether a tenant may be purged — the ONE rule, used by the dry-run, the
 * action and (as a backstop) inside the delete transaction:
 *   - never the bootstrap tenant;
 *   - only a TRIAL tenant (its subscription is TRIALING — the existing
 *     lifecycle, docs/adr/0035): a paying / regular customer is refused;
 *   - never a tenant holding a platform admin account.
 */
export async function purgeRefusal(tenantId: string, db: Pick<typeof prismaBase, "tenant" | "tenantSubscription" | "user"> = prismaBase): Promise<string | null> {
  if (tenantId === BOOTSTRAP_TENANT_ID) return "Le tenant d'amorçage ne peut pas être supprimé.";
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) return `Tenant introuvable : ${tenantId}.`;
  const subscription = await db.tenantSubscription.findUnique({ where: { tenantId }, select: { status: true } });
  if (subscription?.status !== "TRIALING") {
    return "Seul un client en essai (abonnement « TRIALING ») peut être purgé. Un client régulier ne peut pas être supprimé par cette action.";
  }
  const platformAdmins = await db.user.count({ where: { tenantId, isPlatformAdmin: true } });
  if (platformAdmins > 0) return "Ce tenant contient un compte administrateur de la plateforme : purge refusée.";
  return null;
}

export interface TenantPurgePreview {
  tenantId: string;
  /** null = purgeable; otherwise why it is refused. */
  refusal: string | null;
  /** Rows per tenant-owned table that the purge would remove (non-zero only). */
  counts: Record<string, number>;
  total: number;
}

/** Dry-run: counts every tenant-owned row, writes nothing. Platform-only callers. */
export async function previewTenantPurge(tenantId: string): Promise<TenantPurgePreview> {
  const refusal = await runUnscoped("platform:purge-preview", () => purgeRefusal(tenantId));
  const counts: Record<string, number> = {};
  let total = 0;
  await runUnscoped("platform:purge-preview", async () => {
    for (const accessor of TENANT_MODEL_ACCESSORS) {
      const n = await (prismaBase as unknown as Record<string, CountDelegate>)[accessor].count({ where: { tenantId } });
      if (n > 0) counts[accessor] = n;
      total += n;
    }
  });
  return { tenantId, refusal, counts, total };
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
  const refusal = await runUnscoped("platform:delete-tenant", () => purgeRefusal(tenantId));
  if (refusal) {
    if (refusal.startsWith("Tenant introuvable")) throw new TenantNotFoundError(tenantId);
    throw new TenantNotPurgeableError(refusal);
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

        for (const accessor of ACCESS_CONFIG_ACCESSORS) {
          const { count } = await delegateOf(tx, accessor).deleteMany({});
          deletedCounts[accessor] = count;
          totalDeleted += count;
        }

        for (const accessor of ORDER_RETURN_ACCESSORS) {
          const { count } = await delegateOf(tx, accessor).deleteMany({});
          deletedCounts[accessor] = count;
          totalDeleted += count;
        }

        for (const accessor of BUSINESS_ACCESSORS_DELETE_ORDER) {
          const { count } = await delegateOf(tx, accessor).deleteMany({});
          deletedCounts[accessor] = count;
          totalDeleted += count;
        }

        // Proof, before commit: EVERY tenant-owned table (from the schema,
        // not from the lists above) is now empty for this tenant — cascaded
        // rows included. Anything left rolls the whole purge back.
        const remaining: Record<string, number> = {};
        for (const accessor of TENANT_MODEL_ACCESSORS) {
          const n = await (tx as unknown as Record<string, CountDelegate>)[accessor].count();
          if (n > 0) remaining[accessor] = n;
        }
        if (Object.keys(remaining).length > 0) throw new TenantPurgeVerificationError(remaining);

        await tx.tenant.delete({ where: { id: tenantId } });

        return { tenantId, slug: existing.slug, deletedCounts, totalDeleted };
      },
      { maxWait: 15_000, timeout: 120_000 }
    )
  );
}
