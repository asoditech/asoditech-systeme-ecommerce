"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import { validateShopDomain, InvalidShopDomainError } from "@/lib/integrations/shopify/ssrf";
import { ShopifyClient } from "@/lib/integrations/shopify/client";
import { ShopifyError } from "@/lib/integrations/shopify/errors";
import { syncLocations, syncProducts, syncOrders, pushStockToShopify } from "@/lib/integrations/shopify/sync";
import type { SyncSummary } from "@/lib/integrations/shopify/sync";
import { notifyConnectionError, notifySyncFailure } from "@/lib/notifications";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { SyncDirection, SyncRunStatus } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth/session";

interface StoredCredentials {
  apiKey?: string; // Admin API access token
  apiSecret?: string; // webhook signing secret (the custom app's own client secret, provided by the operator — Shopify generates it, this system never does)
}

class NotConfiguredError extends Error {}

async function loadShopifyClient(): Promise<{ integration: NonNullable<Awaited<ReturnType<typeof prisma.integration.findUnique>>>; client: ShopifyClient }> {
  const integration = await prisma.integration.findUnique({ where: { provider: "SHOPIFY" } });
  if (!integration || !integration.credentialsEncrypted) {
    throw new NotConfiguredError("Aucune connexion Shopify configurée.");
  }
  const config = (integration.config as { shopDomain?: string } | null) ?? {};
  if (!config.shopDomain) {
    throw new NotConfiguredError("Aucun domaine de boutique Shopify configuré.");
  }

  const credentials: StoredCredentials = JSON.parse(decryptSecret(integration.credentialsEncrypted));
  if (!credentials.apiKey) {
    throw new NotConfiguredError("Jeton d'accès Shopify manquant.");
  }

  const shopDomain = await validateShopDomain(config.shopDomain);
  const client = new ShopifyClient(shopDomain, credentials.apiKey);
  return { integration, client };
}

function friendlyError(error: unknown): string {
  if (error instanceof NotConfiguredError || error instanceof ShopifyError || error instanceof InvalidShopDomainError) {
    return error.message;
  }
  throw error;
}

/** The only action allowed to advance status to CONNECTE — performs a real authenticated request. */
export async function testShopifyConnectionAction(): Promise<ActionResult<{ status: "CONNECTE" | "ERREUR" }>> {
  const user = await requirePermissionForAction("integrations.manage");

  let integration, client;
  try {
    ({ integration, client } = await loadShopifyClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  try {
    await client.testConnection();
  } catch (error) {
    const message = friendlyError(error);
    await prisma.integration.update({ where: { id: integration.id }, data: { status: "ERREUR", lastError: message } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "integration.connection_test_failed",
      entityType: "Integration",
      entityId: integration.id,
      metadata: { provider: "SHOPIFY" },
    });
    await notifyConnectionError(
      { entityType: "Integration", entityId: integration.id, label: "Shopify", recipientPermission: "integrations.view" },
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
    metadata: { provider: "SHOPIFY" },
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
    metadata: { provider: "SHOPIFY", resource },
  });

  let summary: SyncSummary;
  try {
    summary = await work();
  } catch (error) {
    const message = friendlyError(error);
    await prisma.syncRun.update({ where: { id: syncRun.id }, data: { status: "ECHEC", finishedAt: new Date(), errorSummary: message } });
    await prisma.integration.update({ where: { id: integrationId }, data: { status: "ERREUR", lastError: message } });
    await notifySyncFailure(
      { id: syncRun.id, provider: "Shopify", resource, status: "ECHEC", imported: 0, failed: 0, firstNote: message },
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
    data: { lastSyncAt: new Date(), status: status === "ECHEC" ? "ERREUR" : "CONNECTE", lastError: status === "ECHEC" ? (summary.notes[0] ?? null) : null },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: status === "PARTIEL" ? "integration.sync_partial_failure" : "integration.sync_completed",
    entityType: "SyncRun",
    entityId: syncRun.id,
    metadata: { provider: "SHOPIFY", resource, ...summary },
  });

  if (status === "ECHEC" || status === "PARTIEL") {
    await notifySyncFailure(
      {
        id: syncRun.id,
        provider: "Shopify",
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

export async function syncShopifyProductsAction(): Promise<ActionResult<{ summary: SyncSummary }>> {
  const user = await requirePermissionForAction("integrations.manage");
  let integration, client;
  try {
    ({ integration, client } = await loadShopifyClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  let locationIdMap: Map<string, string> = new Map();
  const locationsResult = await runSync(user, integration.id, "EMPLACEMENTS", "IMPORT", async () => {
    const result = await syncLocations(client);
    locationIdMap = result.idMap;
    return result.summary;
  });
  if (!locationsResult.ok) return locationsResult;

  return runSync(user, integration.id, "PRODUITS", "IMPORT", () => syncProducts(client, locationIdMap, { type: "USER", userId: user.id }));
}

export async function syncShopifyOrdersAction(): Promise<ActionResult<{ summary: SyncSummary }>> {
  const user = await requirePermissionForAction("integrations.manage");
  let integration, client;
  try {
    ({ integration, client } = await loadShopifyClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  // Bound the import to orders created since the last successful sync (or
  // the last 30 days on a first run) — see docs/adr/0011-shopify-integration.md.
  const since = integration.lastSyncAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  return runSync(user, integration.id, "COMMANDES", "IMPORT", () => syncOrders(client, { type: "USER", userId: user.id }, since));
}

export async function pushShopifyStockAction(): Promise<ActionResult<{ summary: SyncSummary }>> {
  const user = await requirePermissionForAction("integrations.manage");
  let integration, client;
  try {
    ({ integration, client } = await loadShopifyClient());
  } catch (error) {
    return actionError(friendlyError(error));
  }

  return runSync(user, integration.id, "STOCK_ENVOI", "EXPORT", () => pushStockToShopify(client));
}
