import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit";
import { verifyShopifyWebhookSignature } from "@/lib/integrations/shopify/webhook-signature";
import { validateShopDomain } from "@/lib/integrations/shopify/ssrf";
import { ShopifyClient } from "@/lib/integrations/shopify/client";
import { importOrder, importProduct } from "@/lib/integrations/shopify/sync";
import { recordWebhookEventOnce, reconcileStockFromProvider } from "@/lib/integrations/shared";

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
  "inventory_levels/update",
]);

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

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-shopify-hmac-sha256");
  const topic = request.headers.get("x-shopify-topic") ?? "inconnu";
  const deliveryId = request.headers.get("x-shopify-webhook-id");

  const integration = await prisma.integration.findUnique({ where: { provider: "SHOPIFY" } });
  if (!integration || !integration.credentialsEncrypted) {
    return new Response(null, { status: 404 });
  }

  const config = (integration.config as { shopDomain?: string } | null) ?? {};
  let apiKey: string | undefined;
  let webhookSecret: string | undefined;
  try {
    const credentials = JSON.parse(decryptSecret(integration.credentialsEncrypted)) as { apiKey?: string; apiSecret?: string };
    apiKey = credentials.apiKey;
    webhookSecret = credentials.apiSecret;
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!webhookSecret || !apiKey || !config.shopDomain) {
    return new Response(null, { status: 404 });
  }

  if (!verifyShopifyWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    await recordAuditEvent({
      actorType: "INTEGRATION",
      action: "integration.webhook_rejected",
      entityType: "Integration",
      entityId: integration.id,
      metadata: { provider: "SHOPIFY", reason: "invalid_signature", topic },
    });
    return new Response(null, { status: 401 });
  }

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

    await importOrder(order, { type: "INTEGRATION" });
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
