import { revalidatePath } from "next/cache";
import type { Integration } from "@prisma/client";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { BOOTSTRAP_TENANT_ID } from "@/lib/tenant/resolve";
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
const SUPPORTED_TOPICS = new Set([
  "order.created",
  "order.updated",
  "product.created",
  "product.updated",
  "product.deleted",
]);

/** A webhook import writes straight to the DB but the Server-Component
 * pages that read it are cached per-path — without this, a new store order
 * only shows up here after a hard reload or a few minutes. Best-effort. */
function revalidateAfterImport(kind: "order" | "product"): void {
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
    // revalidatePath can throw outside a request scope in some runtimes — never fatal here.
  }
}

/**
 * Finds which tenant's WOOCOMMERCE Integration this request's signature
 * belongs to (Phase 3 — docs/adr/0025-multi-tenant-isolation.md): `provider`
 * is no longer globally unique, so a signature-carrying webhook can't be
 * routed by provider alone once a second tenant connects its own store.
 * Tries every WOOCOMMERCE Integration row's secret against the exact raw
 * body, across all tenants (`prismaBase`, unscoped by nature — there is no
 * tenant yet to scope by), and returns whichever one verifies. Mirrors how
 * a multi-account webhook consumer (e.g. Stripe Connect) disambiguates by
 * secret rather than by an id in the URL.
 */
async function resolveWooCommerceIntegrationBySignature(
  rawBody: string,
  signatureHeader: string | null
): Promise<Integration | "invalid_signature" | null> {
  const candidates = await prismaBase.integration.findMany({ where: { provider: "WOOCOMMERCE" } });
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    if (!candidate.credentialsEncrypted) continue;
    let webhookSecret: string | undefined;
    try {
      const credentials = JSON.parse(decryptSecret(candidate.credentialsEncrypted)) as { webhookSecret?: string };
      webhookSecret = credentials.webhookSecret;
    } catch {
      continue;
    }
    if (!webhookSecret) continue;
    if (verifyWebhookSignature(rawBody, signatureHeader, webhookSecret)) return candidate;
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
  const signatureHeader = request.headers.get("x-wc-webhook-signature");
  const topic = request.headers.get("x-wc-webhook-topic") ?? "inconnu";

  const resolved = await resolveWooCommerceIntegrationBySignature(rawBody, signatureHeader);
  if (resolved === null) {
    return new Response(null, { status: 404 });
  }
  if (resolved === "invalid_signature") {
    // No candidate's secret matched — genuinely unknown which tenant (if
    // any) this was meant for. Logged against the bootstrap tenant, same
    // as an unattributable login failure (docs/adr/0024).
    await runWithTenant(BOOTSTRAP_TENANT_ID, "webhook:woocommerce:rejected", () =>
      recordAuditEvent({
        actorType: "INTEGRATION",
        action: "integration.webhook_rejected",
        entityType: "Integration",
        entityId: "unknown",
        metadata: { provider: "WOOCOMMERCE", reason: "invalid_signature", topic },
      })
    );
    return new Response(null, { status: 401 });
  }
  return runWithTenant(resolved.tenantId, "webhook:woocommerce", () =>
    handleWooCommerceWebhook(request, resolved, rawBody)
  );
}

async function handleWooCommerceWebhook(request: Request, integration: Integration, rawBody: string): Promise<Response> {
  const topic = request.headers.get("x-wc-webhook-topic") ?? "inconnu";
  const deliveryId = request.headers.get("x-wc-webhook-delivery-id");

  // Signature already verified during tenant resolution above — no need to
  // re-decrypt/re-verify here.

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

  if (topic === "product.deleted") {
    // WooCommerce sends only `{ id }` here. We archive rather than delete —
    // the product may carry order history and stock movements. An already
    // ARCHIVE/absent product is a no-op.
    const id = (payload as { id?: unknown })?.id;
    if (typeof id !== "number" && typeof id !== "string") {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, status: "ECHEC" });
      return new Response(null, { status: 400 });
    }
    try {
      const product = await prisma.product.findFirst({ where: { source: "WOOCOMMERCE", externalId: String(id) } });
      if (product && product.status !== "ARCHIVE") {
        await prisma.product.update({ where: { id: product.id }, data: { status: "ARCHIVE" } });
        await recordAuditEvent({
          actorType: "INTEGRATION",
          action: "product.archived",
          entityType: "Product",
          entityId: product.id,
          metadata: { source: "WOOCOMMERCE", reason: "deleted_upstream" },
        });
        revalidateAfterImport("product");
      }
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, resourceId: String(id), status: "TRAITE" });
    } catch {
      await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, resourceId: String(id), status: "ECHEC" });
      return new Response(null, { status: 500 });
    }
    return new Response(null, { status: 200 });
  }

  if (topic === "product.created" || topic === "product.updated") {
    // WooCommerce fires this topic for VARIATION saves too, and a
    // variation's REST body (`type: "variation"`, a `parent_id`, `name`
    // like "Tee - Red", `slug: ""`) carries just enough to pass
    // `wcProductSchema` — which would import it as a bogus standalone
    // product. Redirect to a full re-sync of the PARENT instead (that
    // re-syncs every variation + its stock, and self-heals any duplicate
    // a pre-fix delivery already created). See docs/adr/0010 addendum.
    const rawObj = (payload ?? {}) as Record<string, unknown>;
    const parentIdRaw = rawObj.parent_id;
    const parentId =
      typeof parentIdRaw === "number"
        ? parentIdRaw
        : typeof parentIdRaw === "string" && /^\d+$/.test(parentIdRaw)
          ? Number(parentIdRaw)
          : 0;
    const isVariation = rawObj.type === "variation" || parentId > 0;

    if (isVariation) {
      const loaded = await loadWooCommerceClient();
      const resourceId = typeof rawObj.id === "number" || typeof rawObj.id === "string" ? String(rawObj.id) : undefined;
      if (loaded && parentId > 0) {
        try {
          const parent = await loaded.client.getProduct(parentId);
          await importProduct(loaded.client, parent, { type: "INTEGRATION" });
          revalidateAfterImport("product");
          await recordWebhookEventOnce({
            integrationId: integration.id,
            provider: "WOOCOMMERCE",
            deliveryId,
            topic,
            resourceId,
            status: "TRAITE",
          });
        } catch {
          await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, resourceId, status: "ECHEC" });
          return new Response(null, { status: 500 });
        }
      } else {
        // No client, or a variation payload with no usable parent id —
        // acknowledge; "Synchroniser les produits" will reconcile it.
        await recordWebhookEventOnce({ integrationId: integration.id, provider: "WOOCOMMERCE", deliveryId, topic, resourceId, status: "IGNORE" });
      }
      return new Response(null, { status: 200 });
    }

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
      revalidateAfterImport("product");
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
    revalidateAfterImport("order");
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
