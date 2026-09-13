import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Integration } from "@prisma/client";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { BOOTSTRAP_TENANT_ID } from "@/lib/tenant/resolve";
import { decryptSecret } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit";
import { verifyShopifyWebhookSignature } from "@/lib/integrations/shopify/webhook-signature";
import { validateShopDomain } from "@/lib/integrations/shopify/ssrf";
import { ShopifyClient } from "@/lib/integrations/shopify/client";
import { importOrder, importProduct } from "@/lib/integrations/shopify/sync";
import { recordWebhookEventOnce, reconcileStockFromProvider } from "@/lib/integrations/shared";
import { getTenantUsage } from "@/lib/entitlements/usage";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";

/**
 * Shopify webhook receiver — mirrors the WooCommerce webhook route's
 * security model (HMAC verification, replay protection, minimal
 * persisted metadata), adapted for two real Shopify-specific differences:
 *
 * 1. The signing secret is the custom app's own "Client secret", which
 *    Shopify generates and the operator supplies at connect time — this
 *    system never generates it (see docs/adr/0011-shopify-integration.md),
 *    unlike WooCommerce where this system issues the webhook secret.
 * 2. Webhook payload bodies use the classic REST resource JSON shape
 *    (snake_case, numeric ids) — a different shape from the GraphQL
 *    responses the client and sync engine use everywhere else. Rather
 *    than build and maintain a second, parallel REST-shaped mapping
 *    surface (doubling the risk of the two silently drifting apart), this
 *    handler uses the webhook purely as a trigger: for an order or a
 *    product it reads just enough of the body to identify the resource,
 *    then re-fetches it via GraphQL and runs it through the exact same
 *    `importOrder`/`importProduct` pipeline the bulk sync uses. This
 *    guarantees the webhook path can never map something differently than
 *    a manual sync would.
 *
 * Supported topics: orders/create, orders/updated, orders/cancelled,
 * refunds/create (real-time order import); products/create, products/
 * update (real-time product import); inventory_levels/update (real-time
 * stock — the one topic handled directly from the webhook body itself,
 * with no re-fetch: Shopify already gives inventory_item_id/location_id/
 * available, exactly what `reconcileStockFromProvider` needs). All three
 * groups are a safety net layered on top of the resumable bulk sync for a
 * missed or never-configured webhook, not a replacement for it.
 */
const SUPPORTED_TOPICS = new Set([
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "refunds/create",
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
]);

/** Same rationale as the WooCommerce route — refresh the cached pages that
 * read imported data so a new order/product shows up without a hard
 * reload. Best-effort. */
function revalidateAfterImport(kind: "order" | "product" | "stock"): void {
  try {
    if (kind === "order") {
      revalidatePath("/commandes");
      revalidatePath("/tableau-de-bord");
      revalidatePath("/livraison");
      revalidatePath("/clients");
    } else {
      revalidatePath("/produits");
      revalidatePath("/stock");
      revalidatePath("/tableau-de-bord");
    }
  } catch {
    // never fatal
  }
}

const orderEnvelopeSchema = z.object({
  id: z.number(),
  order_id: z.number().optional(),
});

const productEnvelopeSchema = z.object({ id: z.number() });

const inventoryLevelEnvelopeSchema = z.object({
  inventory_item_id: z.number(),
  location_id: z.number(),
  available: z.number(),
});

interface ResolvedShopifyIntegration {
  integration: Integration;
  apiKey: string;
  shopDomain: string;
}

/**
 * Finds which tenant's SHOPIFY Integration this request's signature
 * belongs to (Phase 3 — docs/adr/0025-multi-tenant-isolation.md): `provider`
 * is no longer globally unique, so a signature-carrying webhook can't be
 * routed by provider alone once a second tenant connects its own store.
 * Tries every SHOPIFY Integration row's secret against the exact raw body,
 * across all tenants (`prismaBase`, unscoped by nature — there is no
 * tenant yet to scope by), and returns whichever one verifies.
 */
async function resolveShopifyIntegrationBySignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<ResolvedShopifyIntegration | "invalid_signature" | null> {
  const candidates = await prismaBase.integration.findMany({ where: { provider: "SHOPIFY" } });
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    if (!candidate.credentialsEncrypted) continue;
    const config = (candidate.config as { shopDomain?: string } | null) ?? {};
    if (!config.shopDomain) continue;
    let apiKey: string | undefined;
    let webhookSecret: string | undefined;
    try {
      const credentials = JSON.parse(decryptSecret(candidate.credentialsEncrypted)) as {
        apiKey?: string;
        apiSecret?: string;
      };
      apiKey = credentials.apiKey;
      webhookSecret = credentials.apiSecret;
    } catch {
      continue;
    }
    if (!webhookSecret || !apiKey) continue;
    if (verifyShopifyWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
      return { integration: candidate, apiKey, shopDomain: config.shopDomain };
    }
  }
  return "invalid_signature";
}

export async function POST(request: Request): Promise<Response> {
  // The webhook carries no session, and (Phase 3) the tenant can no longer
  // be found by provider alone — resolve it by matching the signature
  // against every candidate first, then run the handler pinned to that
  // tenant so every read/write lands in the right workspace — never from
  // anything in the request body (docs/adr/0024, docs/adr/0025).
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic") ?? "inconnu";

  const resolved = await resolveShopifyIntegrationBySignature(rawBody, signatureHeader);
  if (resolved === null) {
    return new Response(null, { status: 404 });
  }
  if (resolved === "invalid_signature") {
    // No candidate's secret matched — genuinely unknown which tenant (if
    // any) this was meant for. Logged against the bootstrap tenant, same
    // as an unattributable login failure (docs/adr/0024).
    await runWithTenant(BOOTSTRAP_TENANT_ID, "webhook:shopify:rejected", () =>
      recordAuditEvent({
        actorType: "INTEGRATION",
        action: "integration.webhook_rejected",
        entityType: "Integration",
        entityId: "unknown",
        metadata: { provider: "SHOPIFY", reason: "invalid_signature", topic },
      })
    );
    return new Response(null, { status: 401 });
  }
  return runWithTenant(resolved.integration.tenantId, "webhook:shopify", () =>
    handleShopifyWebhook(request, resolved, rawBody)
  );
}

async function handleShopifyWebhook(
  request: Request,
  resolved: ResolvedShopifyIntegration,
  rawBody: string
): Promise<Response> {
  const { integration, apiKey, shopDomain: configShopDomain } = resolved;
  const topic = request.headers.get("x-shopify-topic") ?? "inconnu";
  const deliveryId = request.headers.get("x-shopify-webhook-id");
  const config = { shopDomain: configShopDomain };

  // Signature already verified during tenant resolution above — no need to
  // re-decrypt/re-verify here.

  if (!deliveryId) {
    return new Response(null, { status: 400 });
  }

  // Replay protection: a captured-and-resent request reuses the exact
  // same delivery id and signature. A legitimate Shopify retry of a
  // genuinely failed delivery gets a NEW delivery id — that case is safe
  // regardless, since order/product import and stock reconciliation are
  // all idempotent.
  const alreadySeen = await prisma.webhookEvent.findUnique({
    where: { integrationId_deliveryId: { integrationId: integration.id, deliveryId } },
  });
  if (alreadySeen) {
    return new Response(null, { status: 200 });
  }

  if (!SUPPORTED_TOPICS.has(topic)) {
    await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, status: "IGNORE" });
    return new Response(null, { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, status: "ECHEC" });
    return new Response(null, { status: 400 });
  }

  if (topic === "inventory_levels/update") {
    const parsed = inventoryLevelEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, status: "ECHEC" });
      return new Response(null, { status: 400 });
    }
    const inventoryItemGid = `gid://shopify/InventoryItem/${parsed.data.inventory_item_id}`;
    const locationGid = `gid://shopify/Location/${parsed.data.location_id}`;

    try {
      const [item, warehouse] = await Promise.all([
        prisma.inventoryItem.findFirst({ where: { externalId: inventoryItemGid } }),
        prisma.warehouse.findFirst({ where: { source: "SHOPIFY", externalId: locationGid } }),
      ]);
      // Nothing local yet maps this inventory item/location — the bulk
      // "Synchroniser les produits" sync is what first establishes that
      // mapping; there's nothing this webhook alone can reconcile against.
      if (item && warehouse && (item.productId || item.variationId)) {
        await reconcileStockFromProvider({
          productId: item.productId ?? undefined,
          variationId: item.variationId ?? undefined,
          warehouseId: warehouse.id,
          externalQuantity: parsed.data.available,
          actor: { type: "INTEGRATION" },
          source: "SHOPIFY",
          externalItemId: inventoryItemGid,
        });
        revalidateAfterImport("stock");
      }
      const outcome = await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: inventoryItemGid, status: "TRAITE" });
      if (outcome === "recorded") {
        await recordAuditEvent({
          actorType: "INTEGRATION",
          action: "integration.webhook_received",
          entityType: "Integration",
          entityId: integration.id,
          metadata: { provider: "SHOPIFY", topic, inventoryItemExternalId: inventoryItemGid },
        });
      }
    } catch {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: inventoryItemGid, status: "ECHEC" });
      return new Response(null, { status: 500 });
    }
    return new Response(null, { status: 200 });
  }

  if (topic === "products/delete") {
    const parsed = productEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, status: "ECHEC" });
      return new Response(null, { status: 400 });
    }
    const productGid = `gid://shopify/Product/${parsed.data.id}`;
    try {
      const product = await prisma.product.findFirst({ where: { source: "SHOPIFY", externalId: productGid } });
      if (product && product.status !== "ARCHIVE") {
        await prisma.product.update({ where: { id: product.id }, data: { status: "ARCHIVE" } });
        await recordAuditEvent({
          actorType: "INTEGRATION",
          action: "product.archived",
          entityType: "Product",
          entityId: product.id,
          metadata: { source: "SHOPIFY", reason: "deleted_upstream" },
        });
        revalidateAfterImport("product");
      }
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: productGid, status: "TRAITE" });
    } catch {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: productGid, status: "ECHEC" });
      return new Response(null, { status: 500 });
    }
    return new Response(null, { status: 200 });
  }

  if (topic === "products/create" || topic === "products/update") {
    const parsed = productEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, status: "ECHEC" });
      return new Response(null, { status: 400 });
    }
    const productGid = `gid://shopify/Product/${parsed.data.id}`;

    try {
      const shopDomain = await validateShopDomain(config.shopDomain);
      const client = new ShopifyClient(shopDomain, apiKey);
      const product = await client.getProduct(productGid);

      if (!product) {
        await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: productGid, status: "ECHEC" });
        return new Response(null, { status: 200 });
      }

      await importProduct(product, { type: "INTEGRATION" });
      revalidateAfterImport("product");
      const outcome = await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: productGid, status: "TRAITE" });
      if (outcome === "recorded") {
        await recordAuditEvent({
          actorType: "INTEGRATION",
          action: "integration.webhook_received",
          entityType: "Integration",
          entityId: integration.id,
          metadata: { provider: "SHOPIFY", topic, productExternalId: productGid },
        });
      }
    } catch {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: productGid, status: "ECHEC" });
      return new Response(null, { status: 500 });
    }
    return new Response(null, { status: 200 });
  }

  const parsed = orderEnvelopeSchema.safeParse(payload);
  const orderNumericId = topic === "refunds/create" ? parsed.data?.order_id : parsed.data?.id;
  if (!parsed.success || !orderNumericId) {
    await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, status: "ECHEC" });
    return new Response(null, { status: 400 });
  }

  const orderGid = `gid://shopify/Order/${orderNumericId}`;

  try {
    const shopDomain = await validateShopDomain(config.shopDomain);
    const client = new ShopifyClient(shopDomain, apiKey);
    const order = await client.getOrder(orderGid);

    if (!order) {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: orderGid, status: "ECHEC" });
      return new Response(null, { status: 200 });
    }

    const rawConfig = (integration.config as Record<string, unknown> | null) ?? {};
    // On by default (see ImportOrderOptions's doc comment) — only an
    // explicit `false` opts out, so the webhook path matches the bulk
    // sync path exactly.
    await importOrder(order, { type: "INTEGRATION" }, { forceNouvelleOnFirstImport: rawConfig.forceNouvelleOnImport !== false });
    revalidateAfterImport("order");
    // Soft, informational only (docs/adr/0035) — a webhook-imported order
    // is never rejected or delayed because of a plan's order limit.
    const usage = await getTenantUsage(integration.tenantId);
    await checkAndNotifyUsageThreshold(integration.tenantId, "ORDERS", usage.orders);
    const outcome = await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: orderGid, status: "TRAITE" });
    if (outcome === "recorded") {
      await recordAuditEvent({
        actorType: "INTEGRATION",
        action: "integration.webhook_received",
        entityType: "Integration",
        entityId: integration.id,
        metadata: { provider: "SHOPIFY", topic, orderExternalId: orderGid },
      });
    }
  } catch {
    await recordWebhookEventOnce({ integrationId: integration.id, provider: "SHOPIFY", deliveryId, topic, resourceId: orderGid, status: "ECHEC" });
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
}
