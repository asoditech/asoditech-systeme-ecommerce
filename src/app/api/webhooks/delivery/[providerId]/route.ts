import { prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { handleDeliveryWebhook } from "@/lib/integrations/delivery/service";
import { isTenantSuspended, readWebhookBody, WEBHOOK_MAX_BODY_BYTES } from "@/lib/integrations/shared/webhook-body";

/**
 * Generic carrier webhook endpoint — `/api/webhooks/delivery/<ShippingProvider.id>`
 * (docs/adr/0012 « Webhooks / polling », docs/adr/0060). One URL per carrier
 * CONNECTION, so the tenant and the secret come from that connection, never
 * from the payload.
 *
 * - The raw body is read once (same 1 MiB cap as the store webhooks) and
 *   handed unchanged to the adapter's own signature check — each carrier
 *   uses its documented scheme; nothing generic is imposed.
 * - Unknown connection and failed verification answer the same 401, so the
 *   endpoint does not reveal which connection ids exist.
 * - Everything else (secret required, signature, adapter-specific ignore
 *   rule, replay record, authoritative status re-fetch) is
 *   handleDeliveryWebhook, run inside the connection's tenant.
 * - A suspended tenant's events are accepted (200) and not processed, like
 *   the store webhooks.
 */
export async function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }): Promise<Response> {
  const { providerId } = await params;
  const body = await readWebhookBody(request);
  if (!body.ok) {
    console.warn(`[webhook] delivery request rejected: body larger than ${WEBHOOK_MAX_BODY_BYTES} bytes`);
    return new Response(null, { status: 413 });
  }

  const connection = await prismaBase.shippingProvider.findUnique({ where: { id: providerId }, select: { id: true, tenantId: true } });
  if (!connection) return new Response(null, { status: 401 });
  // A suspended company's events are verified first (no existence signal
  // for unsigned requests), then accepted and not processed.
  const tenantSuspended = await isTenantSuspended(connection.tenantId);

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let outcome: Awaited<ReturnType<typeof handleDeliveryWebhook>>;
  try {
    outcome = await runWithTenant(connection.tenantId, "webhook:delivery", () =>
      handleDeliveryWebhook({ providerId: connection.id, rawBody: body.text, headers, deliveryIdHeader: null, tenantSuspended })
    );
  } catch (error) {
    // Recorded ECHEC by the handler (retryable); no detail in the response.
    console.error(`[webhook] delivery processing failed: ${error instanceof Error ? error.name : "unknown"}`);
    return new Response(null, { status: 500 });
  }
  if (outcome.outcome === "rejected") return new Response(null, { status: 401 });
  // Not processed yet → a non-2xx so the carrier retries the same delivery.
  if (outcome.outcome === "failed") return new Response(null, { status: 500 });
  if (outcome.outcome === "in_progress") return new Response(null, { status: 503, headers: { "Retry-After": "60" } });
  return new Response(null, { status: 200 });
}
