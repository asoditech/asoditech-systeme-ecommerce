import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Atomic edits of `Integration.config` (non-secret settings + sync cursors).
 *
 * Before this, every writer read the whole JSON, changed one key and wrote
 * the whole object back (`{ ...config, X }`) — an orders sync, a products
 * sync and a settings toggle running together could each overwrite the
 * others' keys with their stale snapshot (lost update). These helpers touch
 * only their own keys, in one SQL statement (`config || patch`), inside a
 * `prisma.$transaction` so the tenant's RLS settings apply.
 */
export async function patchIntegrationConfig(integrationId: string, patch: Record<string, unknown>): Promise<void> {
  const json = JSON.stringify(patch);
  await prisma.$transaction(
    (tx) =>
      tx.$executeRaw`UPDATE "integrations" SET "config" = COALESCE("config", '{}'::jsonb) || ${json}::jsonb, "updatedAt" = now() WHERE "id" = ${integrationId}`
  );
}

/** How long a sync lease survives a crashed/timed-out run before another run may take over. */
export const SYNC_LEASE_MS = 2 * 60 * 1000;

const leaseKey = (resource: string) => `syncLease_${resource}`;

/**
 * Claims the per-integration, per-resource sync lease — at most ONE run of
 * e.g. the orders import at a time (double click, two tabs, two users).
 * A single conditional UPDATE, so two concurrent claimants can never both
 * win; no database connection or lock is held while the run calls the
 * store's API. A lease left behind by a run that died expires after
 * SYNC_LEASE_MS. Returns false when another run holds it.
 */
export async function claimSyncLease(integrationId: string, resource: string, now: Date = new Date()): Promise<boolean> {
  const key = leaseKey(resource);
  const until = new Date(now.getTime() + SYNC_LEASE_MS).toISOString();
  const claimed = await prisma.$transaction(
    (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        UPDATE "integrations"
        SET "config" = COALESCE("config", '{}'::jsonb) || jsonb_build_object(${key}::text, ${until}::text)
        WHERE "id" = ${integrationId}
          AND (("config"->>${key}) IS NULL OR ("config"->>${key})::timestamptz < ${now.toISOString()}::timestamptz)
        RETURNING "id"`
  );
  return claimed.length === 1;
}

export async function releaseSyncLease(integrationId: string, resource: string): Promise<void> {
  await patchIntegrationConfig(integrationId, { [leaseKey(resource)]: null });
}

export const SYNC_ALREADY_RUNNING_MESSAGE =
  "Synchronisation déjà en cours pour cette boutique — attendez la fin de l'import en cours puis relancez si besoin.";

/**
 * Optional historical backfill (`config.importHistoricalOrders`, default
 * true = unchanged). When a manager turns it OFF, `historyCutoffAt` is set
 * to that moment: the bulk import then ignores orders placed BEFORE it.
 * Orders placed after it keep being imported by the bulk sync and the
 * webhooks exactly as before — only the history is left out.
 */
export function historicalCutoff(config: Record<string, unknown> | null | undefined): Date | null {
  if (!config || config.importHistoricalOrders !== false) return null;
  const raw = config.historyCutoffAt;
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** « N commande(s) ignorée(s) : statut … non pris en charge (a ×2, b) » — one aggregated line instead of one note per order. */
export function unsupportedStatusNote(platform: string, counts: ReadonlyMap<string, number>): string | null {
  if (counts.size === 0) return null;
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const list = [...counts.entries()].map(([s, n]) => (n > 1 ? `${s} ×${n}` : s)).join(", ");
  return `${total} commande(s) ignorée(s) : statut ${platform} non pris en charge (${list}).`;
}
