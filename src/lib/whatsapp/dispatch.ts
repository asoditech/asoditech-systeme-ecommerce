import "server-only";

import { prisma } from "@/lib/prisma";
import { isWhatsAppConfigured, sendTemplateMessage } from "@/lib/whatsapp/client";
import { normalizeStaffWhatsAppPhone } from "@/lib/whatsapp/phone";
import type { WhatsAppTemplateMessage } from "@/lib/whatsapp/templates";

/**
 * WhatsApp delivery of a critical notification — docs/adr/0058.
 *
 * Called by `notify()` (and the delivery-failure bundler) with users it
 * ALREADY selected — same tenant, ACTIVE, effective permission, location
 * scope (ADR 0056) — and only those whose in-app row was newly inserted
 * (the dedupe key is the idempotency key, no send log). This module only
 * NARROWS that set; it never adds a recipient:
 *   - the tenant enabled WhatsApp (Integration WHATSAPP = CONNECTE) and the
 *     central sender is configured;
 *   - the user verified their own number and explicitly opted in.
 * Best-effort: never throws, runs after the business transaction commits.
 */

export interface WhatsAppRecipientState {
  whatsappPhone: string | null;
  whatsappVerifiedAt: Date | null;
  whatsappOptInAt: Date | null;
}

/** Verified number + explicit opt-in (opt-in is only possible once verified). */
export function isWhatsAppRecipientReady(u: WhatsAppRecipientState): boolean {
  return Boolean(u.whatsappVerifiedAt && u.whatsappOptInAt && normalizeStaffWhatsAppPhone(u.whatsappPhone));
}

/** The current tenant switched WhatsApp on, and the central sender exists. */
export async function isWhatsAppEnabledForTenant(): Promise<boolean> {
  if (!isWhatsAppConfigured()) return false;
  const row = await prisma.integration.findFirst({ where: { provider: "WHATSAPP" }, select: { status: true } });
  return row?.status === "CONNECTE";
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Atomic "first delivery-failure WhatsApp of the UTC day" claim on the
 * user's own row: a conditional UPDATE, so two concurrent bundles cannot
 * both win. Claimed before sending (no retries in V1).
 */
async function claimDailyDeliveryFailure(userId: string): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ whatsappDeliveryFailureNotifiedAt: null }, { whatsappDeliveryFailureNotifiedAt: { lt: startOfUtcDay() } }],
    },
    data: { whatsappDeliveryFailureNotifiedAt: new Date() },
  });
  return count === 1;
}

export async function sendWhatsAppToUsers(
  items: { userId: string; message: WhatsAppTemplateMessage }[],
  options: { oncePerDay?: "delivery_failure" } = {}
): Promise<void> {
  try {
    if (items.length === 0) return;
    const users = await prisma.user.findMany({
      where: { id: { in: items.map((i) => i.userId) }, status: "ACTIVE" },
      select: { id: true, whatsappPhone: true, whatsappVerifiedAt: true, whatsappOptInAt: true },
    });
    const ready = new Map(users.filter(isWhatsAppRecipientReady).map((u) => [u.id, normalizeStaffWhatsAppPhone(u.whatsappPhone)!]));
    if (ready.size === 0) return;
    if (!(await isWhatsAppEnabledForTenant())) return;

    for (const item of items) {
      const to = ready.get(item.userId);
      if (!to) continue;
      if (options.oncePerDay === "delivery_failure" && !(await claimDailyDeliveryFailure(item.userId))) continue;
      await sendTemplateMessage(to, item.message);
    }
  } catch (error) {
    console.error(`[whatsapp] dispatch failed (non-fatal): ${error instanceof Error ? error.name : "unknown"}`);
  }
}
