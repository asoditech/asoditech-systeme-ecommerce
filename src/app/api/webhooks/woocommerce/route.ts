import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit";
import { verifyWebhookSignature } from "@/lib/integrations/woocommerce/webhook-signature";
import { importOrder, importProduct } from "@/lib/integrations/woocommerce/sync";
import { wcOrderSchema, wcProductSchema } from "@/lib/integrations/woocommerce/types";
import { loadWooCommerceClient } from "@/lib/integrations/woocommerce/client-loader";
import { recordWebhookEventOnce } from "@/lib/integrations/shared";

/**
 * WooCommerce webhook receiver — the only route in this app authenticated
 * by a shared-secret signature instead of a user session (see
 * docs/adr/0010-woocommerce-integration.md). Supported topics:
 * order.created/order.updated (real-time order import) and
 * product.created/product.updated (real-time product + stock sync,
 * layered on top of the resumable bulk "Synchroniser les produits" as a
 * safety net for a missed or never-configured webhook, not a replacement
 * for it). Every other topic is acknowledged (200) but ignored, so
 * WooCommerce doesn't keep retrying a topic this app never intends to
 * support, without this endpoint becoming a generic "accept anything"
 * sink. WooCommerce sends the full resource (order or product) as the
 * webhook body itself — the same shape `wcOrderSchema`/`wcProductSchema`
 * already validate everywhere else, so there is no separate re-fetch step
 * here (unlike Shopify's webhook, whose REST-shaped body isn't reused
 * directly — see that route's own doc comment).
 *
 * Security, in order: verify the HMAC-SHA256 signature over the exact raw
 * body against the stored per-integration secret (constant-time compare);
 * reject if the delivery id was already processed (replay protection);
 * only then parse and act on the body. No raw external payload is ever
 * persisted — see the WebhookEvent model.
 */
const SUPPORTED_TOPICS = new Set(["order.created", "order.updated", "product.created", "product.updated"]);

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("x-wc-webhook-signature");
  const topic = request.headers.get("x-wc-webhook-topic") ?? "inconnu";
  const deliveryId = request.headers.get("x-wc-webhook-delivery-id");

  const integration = await prisma.integration.findUnique({ where: { provider: "WOOCOMMERCE" } });
  if (!integration || !integration.credentialsEncrypted) {
    return new Response(null, { status: 404 });
  }

  let webhookSecret: string | undefined;
  try {
    const credentials = JSON.parse(decryptSecret(integration.credentialsEncrypted)) as { webhookSecret?: string };
    webhookSecret = credentials.webhookSecret;
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!webhookSecret) {
    return new Response(null, { status: 404 });
  }

  if (!verifyWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    await recordAuditEvent({
      actorType: "INTEGRATION",
      action: "integration.webhook_rejected",
      entityType: "Integration",
      entityId: integration.id,
      metadata: { provider: "WOOCOMMERCE", reason: "invalid_signature", topic },
    });
    return new Response(null, { status: 401 });
  }

  if (!deliveryId) {
    return new Response(null, { status: 400 });
  }

  // Replay protection: a captured-and-resent request reuses the exact same
  // delivery id and signature. A legitimate WooCommerce retry of a
  // genuinely failed delivery gets a NEW delivery id — that case is safe
  // regardless, since order/product import is idempotent by (source, externalId).
  const alreadySeen = await prisma.webhookEvent.findUnique({
    where: { integrationId_deliveryId: { integrationId: integration.id, deliveryId } },
  });
  if (alreadySeen) {
    return new Response(null, { status: 200 });
  }

  if (!SUPPORTED_TOPICS.has(topic)) {
    await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, status: "IGNORE" });
    return new Response(null, { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, status: "ECHEC" });
    return new Response(null, { status: 400 });
  }

  if (topic === "product.created" || topic === "product.updated") {
    const parsed = wcProductSchema.safeParse(payload);
    if (!parsed.success) {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, status: "ECHEC" });
      return new Response(null, { status: 400 });
    }

    const loaded = await loadWooCommerceClient();
    if (!loaded) {
      // Configured well enough to have a webhook secret but not (or no
      // longer) real API credentials — nothing this route can do about
      // that; the bulk sync's own "Synchroniser les produits" will report
      // the same problem the next time it's run.
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, resourceId: String(parsed.data.id), status: "ECHEC" });
      return new Response(null, { status: 200 });
    }

    try {
      await importProduct(loaded.client, parsed.data, { type: "INTEGRATION" });
      const outcome = await recordWebhookEventOnce({
        integrationId: integration.id,
        provider: "WOOCOMMERCE",
        deliveryId,
        topic,
        resourceId: String(parsed.data.id),
        status: "TRAITE",
      });
      if (outcome === "recorded") {
        await recordAuditEvent({
          actorType: "INTEGRATION",
          action: "integration.webhook_received",
          entityType: "Integration",
          entityId: integration.id,
          metadata: { provider: "WOOCOMMERCE", topic, productExternalId: parsed.data.id },
        });
      }
    } catch {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, resourceId: String(parsed.data.id), status: "ECHEC" });
      return new Response(null, { status: 500 });
    }

    return new Response(null, { status: 200 });
  }

  const parsed = wcOrderSchema.safeParse(payload);
  if (!parsed.success) {
    await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, status: "ECHEC" });
    return new Response(null, { status: 400 });
  }

  try {
    await importOrder(parsed.data, { type: "INTEGRATION" });
    const outcome = await recordWebhookEventOnce({
      integrationId: integration.id,
      provider: "WOOCOMMERCE",
      deliveryId,
      topic,
      resourceId: String(parsed.data.id),
      status: "TRAITE",
    });
    if (outcome === "recorded") {
      await recordAuditEvent({
        actorType: "INTEGRATION",
        action: "integration.webhook_received",
        entityType: "Integration",
        entityId: integration.id,
        metadata: { provider: "WOOCOMMERCE", topic, orderExternalId: parsed.data.id },
      });
    }
  } catch {
    await recordWebhookEventOnce({
      integrationId: integration.id,
      provider: "WOOCOMMERCE",
      deliveryId,
      topic,
      resourceId: String(parsed.data.id),
      status: "ECHEC",
    });
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
}
