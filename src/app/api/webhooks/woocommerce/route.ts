import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { recordAuditEvent } from "@/lib/audit";
import { verifyWebhookSignature } from "@/lib/integrations/woocommerce/webhook-signature";
import { importOrder } from "@/lib/integrations/woocommerce/sync";
import { wcOrderSchema } from "@/lib/integrations/woocommerce/types";
import { recordWebhookEventOnce } from "@/lib/integrations/shared";

/**
 * WooCommerce webhook receiver — the only route in this app authenticated
 * by a shared-secret signature instead of a user session (see
 * docs/adr/0010-woocommerce-integration.md). Deliberately narrow: only
 * order.created/order.updated are accepted; every other topic is
 * acknowledged (200) but ignored, so WooCommerce doesn't keep retrying a
 * topic we never intend to support, without this endpoint becoming a
 * generic "accept anything" sink.
 *
 * Security, in order: verify the HMAC-SHA256 signature over the exact raw
 * body against the stored per-integration secret (constant-time compare);
 * reject if the delivery id was already processed (replay protection);
 * only then parse and act on the body. No raw external payload is ever
 * persisted — see the WebhookEvent model.
 */
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
  // regardless, since order import is idempotent by (source, externalId).
  const alreadySeen = await prisma.webhookEvent.findUnique({
    where: { integrationId_deliveryId: { integrationId: integration.id, deliveryId } },
  });
  if (alreadySeen) {
    return new Response(null, { status: 200 });
  }

  const SUPPORTED_TOPICS = new Set(["order.created", "order.updated"]);
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
