import "server-only";

import { prismaBase } from "@/lib/prisma";

/**
 * Webhook request policies shared by the WooCommerce and Shopify receivers
 * (owner decisions 2026-10-14, docs/decisions/order-sync-open-decisions.md,
 * « Webhook policy choices »).
 */

/**
 * Application-level maximum webhook body: 1 MiB (1 048 576 bytes). A body
 * of EXACTLY this size is accepted; one byte more → 413. Order and product
 * payloads are a few kilobytes; the limit exists so an oversized request is
 * never parsed, never signature-checked against every connected company
 * (one HMAC per integration), and never processed. The hosting platform may
 * impose its own, larger request limit before the app is reached (Vercel
 * functions: 4.5 MB) — the effective limit is the smaller of the two.
 */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export type WebhookBodyResult = { ok: true; text: string } | { ok: false; status: 413 };

/**
 * Reads the raw request body with a hard byte limit, BEFORE any parsing or
 * signature work:
 * 1. a declared `Content-Length` above the limit is refused without reading
 *    the body at all;
 * 2. otherwise the body stream is read chunk by chunk and abandoned
 *    (`reader.cancel()`) as soon as the running total exceeds the limit — a
 *    missing or understated Content-Length (chunked transfer) cannot make
 *    the app buffer more than limit + one chunk.
 * The accepted bytes are decoded exactly like `Request.text()` (UTF-8,
 * replacement on invalid sequences), so signature verification still runs
 * over the identical raw body string.
 */
export async function readWebhookBody(request: Request, limit: number = WEBHOOK_MAX_BODY_BYTES): Promise<WebhookBodyResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > limit) {
    return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
}

/** The 413 answer: no body, nothing recorded (no company is known yet). */
export function payloadTooLargeResponse(provider: "WOOCOMMERCE" | "SHOPIFY"): Response {
  console.warn(`[webhook] ${provider} request rejected: body larger than ${WEBHOOK_MAX_BODY_BYTES} bytes`);
  return new Response(null, { status: 413 });
}

/**
 * Suspended companies (ADR 0053 suspension model, extended 2026-10-14): a
 * webhook of a suspended company is authenticated (its signature verified)
 * but NOT processed — no order, product or stock change. The delivery is
 * recorded once as « SUSPENDU » and acknowledged with 200: both providers
 * retry non-2xx answers and eventually disable the subscription, which an
 * intentional suspension must not cause. Reactivation does not replay these
 * deliveries (a recorded, non-ECHEC delivery id is never processed again);
 * the store's state is caught up by « Synchroniser les commandes / les
 * produits » after reactivation. Read with the unscoped client: the tenant
 * row itself, resolved from the verifying integration — never from the body.
 */
export async function isTenantSuspended(tenantId: string): Promise<boolean> {
  const tenant = await prismaBase.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
  return tenant?.status === "SUSPENDED";
}
