import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit";
import { verifyShopifyWebhookSignature } from "@/lib/integrations/shopify/webhook-signature";
import { validateShopDomain } from "@/lib/integrations/shopify/ssrf";
import { ShopifyClient } from "@/lib/integrations/shopify/client";
import { importOrder } from "@/lib/integrations/shopify/sync";
import { recordWebhookEventOnce } from "@/lib/integrations/shared";

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
 *    handler uses the webhook purely as a trigger: it verifies the
 *    delivery, reads just enough of the body to identify the order
 *    (`id`, or `order_id` for the refunds/create topic), then re-fetches
 *    that order via GraphQL and runs it through the exact same
 *    `importOrder` pipeline the bulk sync uses. This guarantees the
 *    webhook path can never map an order differently than a manual sync
 *    would.
 *
 * Supported topics: orders/create, orders/updated, orders/cancelled,
 * refunds/create — all four resolve to "(re-)import this order's current
 * state", which importOrder already handles idempotently and correctly
 * for a cancellation or a refund. products/update and inventory-level
 * webhooks are deliberately not implemented in this phase — see the ADR's
 * "deferred" section.
 */
const SUPPORTED_TOPICS = new Set(["orders/create", "orders/updated", "orders/cancelled", "refunds/create"]);

const webhookEnvelopeSchema = z.object({
  id: z.number(),
  order_id: z.number().optional(),
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
  // regardless, since order import is idempotent by (source, externalId).
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

  const parsed = webhookEnvelopeSchema.safeParse(payload);
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
