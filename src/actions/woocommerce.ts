"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { SYNC_ALREADY_RUNNING_MESSAGE, claimSyncLease, patchIntegrationConfig, releaseSyncLease } from "@/lib/integrations/shared/integration-config";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { InvalidStoreUrlError } from "@/lib/integrations/woocommerce/ssrf";
import { WooCommerceError } from "@/lib/integrations/woocommerce/errors";
import { generateWebhookSecret } from "@/lib/integrations/woocommerce/webhook-signature";
import {
  inventoryOwnerOf,
  inventoryOwnerSchema,
  remoteDeletionModeOf,
  remoteDeletionModeSchema,
  type InventoryOwner,
  type RemoteDeletionMode,
} from "@/lib/integrations/woocommerce/store-settings";
import { loadWooCommerceClient as loadWooCommerceClientOrNull } from "@/lib/integrations/woocommerce/client-loader";
import { syncCategories, syncProducts, syncOrders, pushStockToWooCommerce } from "@/lib/integrations/woocommerce/sync";
import type { SyncSummary } from "@/lib/integrations/woocommerce/sync";
import { notifyConnectionError, notifySyncFailure } from "@/lib/notifications";
import { getTenantUsage } from "@/lib/entitlements/usage";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { SyncDirection, SyncRunStatus } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth/session";

interface StoredCredentials {
  apiKey?: string;
  apiSecret?: string;
  webhookSecret?: string;
}

class NotConfiguredError extends Error {}

/**
 * Thin action-layer wrapper over the shared, non-throwing loader — this
 * call site wants "not configured" to surface as a friendly actionError,
 * unlike the automatic webhook/stock-push paths that share the same
 * underlying loader and just silently no-op instead.
 */
async function loadWooCommerceClient() {
  const result = await loadWooCommerceClientOrNull();
  if (!result) {
    throw new NotConfiguredError("Aucune connexion WooCommerce configurée ou identifiants incomplets.");
  }
  return result;
}

function friendlyError(error: unknown): string {
  if (error instanceof NotConfiguredError || error instanceof WooCommerceError || error instanceof InvalidStoreUrlError) {
    return error.message;
  }
  throw error;
}

/**
 * The only action allowed to advance status to CONNECTE — it performs a
 * real authenticated request against the store. See
 * docs/adr/0010-woocommerce-integration.md.
 */
export async function testWooCommerceConnectionAction(): Promise<ActionResult<{ status: "CONNECTE" | "ERREUR" }>> {
  const user = await requirePermissionForAction("integrations.manage");

  let integration;
  let client;
  try {
    ({ integration, client } = await loadWooCommerceClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  try {
    await client.testConnection();
  } catch (error) {
    const message = friendlyError(error);
    await prisma.integration.update({
      where: { id: integration.id },
      data: { status: "ERREUR", lastError: message },
    });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "integration.connection_test_failed",
      entityType: "Integration",
      entityId: integration.id,
      metadata: { provider: "WOOCOMMERCE" },
    });
    await notifyConnectionError(
      { entityType: "Integration", entityId: integration.id, label: "WooCommerce", recipientPermission: "integrations.view" },
      user.id
    );
    revalidatePath("/integrations");
    return actionError(message);
  }

  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: "CONNECTE", lastError: null, lastConnectionCheckAt: new Date() },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.connection_test_succeeded",
    entityType: "Integration",
    entityId: integration.id,
    metadata: { provider: "WOOCOMMERCE" },
  });

  revalidatePath("/integrations");
  return actionOk({ status: "CONNECTE" });
}

async function runSync(
  user: CurrentUser,
  integrationId: string,
  resource: string,
  direction: SyncDirection,
  work: () => Promise<SyncSummary>
): Promise<ActionResult<{ summary: SyncSummary }>> {
  const syncRun = await prisma.syncRun.create({
    data: { integrationId, resource, direction, status: "EN_COURS", triggeredById: user.id },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.sync_started",
    entityType: "SyncRun",
    entityId: syncRun.id,
    metadata: { provider: "WOOCOMMERCE", resource },
  });

  let summary: SyncSummary;
  try {
    summary = await work();
  } catch (error) {
    const message = friendlyError(error);
    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "ECHEC", finishedAt: new Date(), errorSummary: message },
    });
    await prisma.integration.update({ where: { id: integrationId }, data: { status: "ERREUR", lastError: message } });
    await notifySyncFailure(
      { id: syncRun.id, provider: "WooCommerce", resource, status: "ECHEC", imported: 0, failed: 0, firstNote: message },
      user.id
    );
    revalidatePath("/integrations");
    return actionError(message);
  }

  const status: SyncRunStatus = summary.failed > 0 ? (summary.imported + summary.updated > 0 ? "PARTIEL" : "ECHEC") : "SUCCES";
  await prisma.syncRun.update({
    where: { id: syncRun.id },
    data: {
      status,
      finishedAt: new Date(),
      itemsImported: summary.imported,
      itemsUpdated: summary.updated,
      itemsUnchanged: summary.unchanged,
      itemsSkipped: summary.skipped,
      itemsProcessed: summary.imported + summary.updated + summary.unchanged,
      itemsFailed: summary.failed,
      errorSummary: summary.notes.length > 0 ? summary.notes.join(" | ").slice(0, 2000) : null,
    },
  });
  await prisma.integration.update({
    where: { id: integrationId },
    data: { lastSyncAt: new Date(), status: status === "ECHEC" ? "ERREUR" : "CONNECTE", lastError: status === "ECHEC" ? summary.notes[0] ?? null : null },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: status === "PARTIEL" ? "integration.sync_partial_failure" : "integration.sync_completed",
    entityType: "SyncRun",
    entityId: syncRun.id,
    metadata: { provider: "WOOCOMMERCE", resource, ...summary },
  });

  if (status === "ECHEC" || status === "PARTIEL") {
    await notifySyncFailure(
      {
        id: syncRun.id,
        provider: "WooCommerce",
        resource,
        status,
        imported: summary.imported,
        failed: summary.failed,
        firstNote: summary.notes[0] ?? null,
      },
      user.id
    );
  }

  revalidatePath("/integrations");
  return actionOk({ summary });
}

export async function syncWooCommerceProductsAction(): Promise<ActionResult<{ summary: SyncSummary }>> {
  const user = await requirePermissionForAction("integrations.manage");
  let integration, client;
  try {
    ({ integration, client } = await loadWooCommerceClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  let idMap: Map<number, string> = new Map();
  const categoriesResult = await runSync(user, integration.id, "CATEGORIES", "IMPORT", async () => {
    const result = await syncCategories(client);
    idMap = result.idMap;
    return result.summary;
  });
  if (!categoriesResult.ok) return categoriesResult;

  return runSync(user, integration.id, "PRODUITS", "IMPORT", () =>
    syncProducts(client, idMap, { type: "USER", userId: user.id }, integration.id)
  );
}

export async function syncWooCommerceOrdersAction(): Promise<ActionResult<{ summary: SyncSummary }>> {
  const user = await requirePermissionForAction("integrations.manage");
  let integration, client;
  try {
    ({ integration, client } = await loadWooCommerceClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  // syncOrders skips orders already held, imports at most a small number
  // of new ones per run, and persists how far it got so the next run
  // resumes there instead of rescanning — sized for Vercel Hobby's ~10s
  // limit. A large first backfill completes over several runs, which the
  // client re-invokes automatically while summary.hasMore is true. See
  // docs/adr/0010-woocommerce-integration.md.
  // One orders import at a time per store (double click, two tabs, two
  // users): the second is refused instead of racing the first.
  if (!(await claimSyncLease(integration.id, "orders"))) {
    return actionError(SYNC_ALREADY_RUNNING_MESSAGE);
  }
  let result: ActionResult<{ summary: SyncSummary }>;
  try {
    result = await runSync(user, integration.id, "COMMANDES", "IMPORT", () =>
      syncOrders(client, { type: "USER", userId: user.id }, integration.id)
    );
  } finally {
    await releaseSyncLease(integration.id, "orders");
  }
  // Soft, informational only (docs/adr/0035) — a bulk import never fails
  // or is throttled because of a plan's order limit; checked once per
  // sync run rather than per imported order to stay cheap.
  if (result.ok) {
    const usage = await getTenantUsage(user.tenantId);
    await checkAndNotifyUsageThreshold(user.tenantId, "ORDERS", usage.orders);
  }
  return result;
}

export async function pushWooCommerceStockAction(): Promise<ActionResult<{ summary: SyncSummary }>> {
  const user = await requirePermissionForAction("integrations.manage");
  let integration, client;
  try {
    ({ integration, client } = await loadWooCommerceClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  return runSync(user, integration.id, "STOCK_ENVOI", "EXPORT", () =>
    pushStockToWooCommerce(client, { inventoryOwner: inventoryOwnerOf(integration.config) })
  );
}

/**
 * Generates (or regenerates) the shared secret used to verify inbound
 * WooCommerce webhook deliveries, and returns it in plaintext exactly
 * once, in this response, so the operator can paste it into WooCommerce
 * admin (Réglages → Avancé → Webhooks) — WooCommerce webhooks are
 * registered manually in this phase, not created via the API (see
 * docs/adr/0010-woocommerce-integration.md). It is never retrievable
 * again after this — only its encrypted form is stored.
 */
export async function generateWooCommerceWebhookSecretAction(): Promise<ActionResult<{ secret: string }>> {
  const user = await requirePermissionForAction("integrations.manage");

  const integration = await prisma.integration.findFirst({ where: { provider: "WOOCOMMERCE" } });
  if (!integration || !integration.credentialsEncrypted) {
    return actionError("Configurez d'abord la connexion WooCommerce.");
  }

  const credentials: StoredCredentials = JSON.parse(decryptSecret(integration.credentialsEncrypted));
  const secret = generateWebhookSecret();
  credentials.webhookSecret = secret;

  await prisma.integration.update({
    where: { id: integration.id },
    data: { credentialsEncrypted: encryptSecret(JSON.stringify(credentials)) },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.updated",
    entityType: "Integration",
    entityId: integration.id,
    metadata: { provider: "WOOCOMMERCE", change: "webhook_secret_regenerated" },
  });

  revalidatePath("/integrations");
  return actionOk({ secret });
}

/**
 * Client preference (docs/adr/0010 addendum): when enabled, a first-time
 * WooCommerce import that would otherwise land as CONFIRMEE ("processing")
 * is created as NOUVELLE instead, so the confirmation team always phones
 * the customer before the order counts as confirmed. Off by default —
 * matches WooCommerce's own status as before. Stored on `Integration.config`
 * (non-secret settings), applied in `importOrder` for both the bulk sync
 * and the order webhook.
 */
export async function setWooCommerceForceNouvelleOnImportAction(enabled: boolean): Promise<ActionResult<{ enabled: boolean }>> {
  const user = await requirePermissionForAction("integrations.manage");

  const integration = await prisma.integration.findFirst({ where: { provider: "WOOCOMMERCE" } });
  if (!integration) {
    return actionError("Configurez d'abord la connexion WooCommerce.");
  }

  await patchIntegrationConfig(integration.id, { forceNouvelleOnImport: enabled });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.updated",
    entityType: "Integration",
    entityId: integration.id,
    metadata: { provider: "WOOCOMMERCE", change: "force_nouvelle_on_import", enabled },
  });

  revalidatePath("/integrations");
  return actionOk({ enabled });
}

/**
 * « Importer l'historique des commandes » (per connection, stored on
 * `Integration.config`, default ON = unchanged). OFF sets the cutoff to now:
 * the bulk « Synchroniser les commandes » then ignores orders placed before
 * it, while newer orders (bulk sync and webhooks) keep being imported.
 * Orders already imported are never removed. Turning it back ON clears the
 * cutoff — the next syncs import the history again.
 */
export async function setWooCommerceImportHistoricalOrdersAction(enabled: boolean): Promise<ActionResult<{ enabled: boolean }>> {
  const user = await requirePermissionForAction("integrations.manage");

  const integration = await prisma.integration.findFirst({ where: { provider: "WOOCOMMERCE" } });
  if (!integration) {
    return actionError("Configurez d'abord la connexion WooCommerce.");
  }

  const cutoff = enabled ? null : new Date().toISOString();
  await patchIntegrationConfig(integration.id, { importHistoricalOrders: enabled, historyCutoffAt: cutoff });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.updated",
    entityType: "Integration",
    entityId: integration.id,
    metadata: { provider: "WOOCOMMERCE", change: "import_historical_orders", enabled, historyCutoffAt: cutoff },
  });

  revalidatePath("/integrations");
  return actionOk({ enabled });
}

/**
 * « Que faire lorsqu'un produit est supprimé de la boutique ? » — per
 * connection, on `Integration.config.remoteDeletionMode` (missing/invalid =
 * `manual`, src/lib/integrations/woocommerce/store-settings.ts). Validated
 * here, not only in the UI. `auto` only ever unlinks a deletion the store
 * itself confirms (src/lib/integrations/woocommerce/remote-deletion.ts).
 */
export async function setWooCommerceRemoteDeletionModeAction(mode: unknown): Promise<ActionResult<{ mode: RemoteDeletionMode }>> {
  const user = await requirePermissionForAction("integrations.manage");
  const parsed = remoteDeletionModeSchema.safeParse(mode);
  if (!parsed.success) return actionError("Choix invalide.");

  const integration = await prisma.integration.findFirst({ where: { provider: "WOOCOMMERCE" } });
  if (!integration) {
    return actionError("Configurez d'abord la connexion WooCommerce.");
  }

  const previous = remoteDeletionModeOf(integration.config);
  await patchIntegrationConfig(integration.id, { remoteDeletionMode: parsed.data });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.updated",
    entityType: "Integration",
    entityId: integration.id,
    metadata: { provider: "WOOCOMMERCE", change: "remote_deletion_mode", previous, mode: parsed.data },
  });

  revalidatePath("/integrations");
  return actionOk({ mode: parsed.data });
}

/**
 * « Qui gère le stock des produits importés ? » — per connection, on
 * `Integration.config.inventoryOwner` (missing/invalid = `ASODITECH`, the
 * docs/adr/0036 behaviour). Governs the next imports and every outbound
 * stock push (`STORE` → none, sync/stock-push.ts). Switching it never
 * deletes, zeroes or rewrites a stock row, a movement or a quantity, and
 * starts no import and no push; the audit event records how many existing
 * rows of store-linked units the switch affects (kept, no longer / again pushed).
 */
export async function setWooCommerceInventoryOwnerAction(owner: unknown): Promise<ActionResult<{ owner: InventoryOwner }>> {
  const user = await requirePermissionForAction("integrations.manage");
  const parsed = inventoryOwnerSchema.safeParse(owner);
  if (!parsed.success) return actionError("Choix invalide.");

  const integration = await prisma.integration.findFirst({ where: { provider: "WOOCOMMERCE" } });
  if (!integration) {
    return actionError("Configurez d'abord la connexion WooCommerce.");
  }

  const previous = inventoryOwnerOf(integration.config);
  await patchIntegrationConfig(integration.id, { inventoryOwner: parsed.data });
  // Read-only count, for the record: the rows themselves are left untouched.
  const linkedStockRows = await prisma.inventoryItem.count({
    where: {
      OR: [
        { product: { source: "WOOCOMMERCE", externalId: { not: null } } },
        { variation: { source: "WOOCOMMERCE", externalId: { not: null } } },
      ],
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.updated",
    entityType: "Integration",
    entityId: integration.id,
    metadata: { provider: "WOOCOMMERCE", change: "inventory_owner", previous, owner: parsed.data, linkedStockRows },
  });

  revalidatePath("/integrations");
  return actionOk({ owner: parsed.data });
}
