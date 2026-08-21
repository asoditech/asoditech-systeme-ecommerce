import "server-only";

import { prisma } from "@/lib/prisma";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import type { IntegrationProvider } from "@prisma/client";

/**
 * Records a WebhookEvent row, tolerating the exact race the replay-check
 * itself can't close on its own: two genuinely concurrent deliveries with
 * the *same* delivery id can both pass the `findUnique` "already seen?"
 * check before either has committed a row, and then both try to `create`
 * one — the loser hits the (integrationId, deliveryId) unique constraint.
 * That P2002 means "a concurrent request already recorded this delivery",
 * not a real failure, so it's swallowed here rather than left to crash
 * the request (found via a genuine concurrent-delivery test during Phase
 * 21 — see docs/adr/0011-shopify-integration.md; the same fix applies to
 * the WooCommerce webhook route, which had the identical latent race).
 */
export async function recordWebhookEventOnce(data: {
  integrationId: string;
  provider: IntegrationProvider;
  deliveryId: string;
  topic: string;
  resourceId?: string;
  status: "TRAITE" | "IGNORE" | "ECHEC";
}): Promise<"recorded" | "already_recorded"> {
  try {
    await prisma.webhookEvent.create({ data });
    return "recorded";
  } catch (error) {
    if (isUniqueConstraintError(error)) return "already_recorded";
    throw error;
  }
}
