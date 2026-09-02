"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { validateStoreUrl, InvalidStoreUrlError } from "@/lib/integrations/woocommerce/ssrf";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { WooCommerceError } from "@/lib/integrations/woocommerce/errors";
import { generateWebhookSecret } from "@/lib/integrations/woocommerce/webhook-signature";
import { syncCategories, syncProducts, syncOrders, pushStockToWooCommerce } from "@/lib/integrations/woocommerce/sync";
import type { SyncSummary } from "@/lib/integrations/woocommerce/sync";
import { notifyConnectionError, notifySyncFailure } from "@/lib/notifications";
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
 * Loads the single WooCommerce Integration row, decrypts its credentials,
 * re-validates the store URL (DNS can change between save time and now —
 * see docs/adr/0010-woocommerce-integration.md), and builds a client.
 * Throws NotConfiguredError (turned into a friendly actionError by every
 * caller) if nothing is configured yet.
 */
async function loadWooCommerceClient(): Promise<{ integration: NonNullable<Awaited<ReturnType<typeof prisma.integration.findUnique>>>; client: WooCommerceClient; credentials: StoredCredentials }> {
  const integration = await prisma.integration.findUnique({ where: { provider: "WOOCOMMERCE" } });
  if (!integration || !integration.credentialsEncrypted) {
    throw new NotConfiguredError("Aucune connexion WooCommerce configurée.");
  }
  const config = (integration.config as { siteUrl?: string } | null) ?? {};
  if (!config.siteUrl) {
    throw new NotConfiguredError("Aucune URL de boutique WooCommerce configurée.");
  }

  const credentials: StoredCredentials = JSON.parse(decryptSecret(integration.credentialsEncrypted));
  if (!credentials.apiKey || !credentials.apiSecret) {
    throw new NotConfiguredError("Identifiants WooCommerce incomplets.");
  }

  const storeUrl = await validateStoreUrl(config.siteUrl);
  const client = new WooCommerceClient(storeUrl, {
    consumerKey: credentials.apiKey,
    consumerSecret: credentials.apiSecret,
  });
  return { integration, client, credentials };
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
    syncProducts(client, idMap, { type: "USER", userId: user.id })
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

  // Bound the import to orders created since the last successful sync (or
  // the last 30 days on a first run) rather than the store's entire order
  // history every time — see docs/adr/0010-woocommerce-integration.md.
  const since = integration.lastSyncAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  return runSync(user, integration.id, "COMMANDES", "IMPORT", () =>
    syncOrders(client, { type: "USER", userId: user.id }, since)
  );
}

export async function pushWooCommerceStockAction(): Promise<ActionResult<{ summary: SyncSummary }>> {
  const user = await requirePermissionForAction("integrations.manage");
  let integration, client;
  try {
    ({ integration, client } = await loadWooCommerceClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  return runSync(user, integration.id, "STOCK_ENVOI", "EXPORT", () => pushStockToWooCommerce(client));
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

  const integration = await prisma.integration.findUnique({ where: { provider: "WOOCOMMERCE" } });
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
