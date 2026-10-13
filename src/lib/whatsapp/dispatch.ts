import "server-only";

import { prisma } from "@/lib/prisma";
import { isWhatsAppConfigured, sendTemplateMessage } from "@/lib/whatsapp/client";
import { normalizeStaffWhatsAppPhone } from "@/lib/whatsapp/phone";
import type { WhatsAppTemplateMessage } from "@/lib/whatsapp/templates";
import { isWhatsAppAlertMuted } from "@/lib/whatsapp/alert-types";

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
 *   - the user verified their own number and explicitly opted in;
 *   - the user did not mute this alert type for WhatsApp
 *     (`User.whatsappMutedAlerts`, Paramètres → Notifications).
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
 * both win. Claimed before sending (no retries in V1); returns the claim
 * time, or null when another bundle already holds today's claim.
 */
async function claimDailyDeliveryFailure(userId: string): Promise<Date | null> {
  const claimedAt = new Date();
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ whatsappDeliveryFailureNotifiedAt: null }, { whatsappDeliveryFailureNotifiedAt: { lt: startOfUtcDay() } }],
    },
    data: { whatsappDeliveryFailureNotifiedAt: claimedAt },
  });
  return count === 1 ? claimedAt : null;
}

/** Gives today's claim back after a send Meta refused, so a later failure summary can still go out today. */
async function releaseDailyDeliveryFailure(userId: string, claimedAt: Date): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, whatsappDeliveryFailureNotifiedAt: claimedAt },
    data: { whatsappDeliveryFailureNotifiedAt: null },
  });
}

export async function sendWhatsAppToUsers(
  items: { userId: string; message: WhatsAppTemplateMessage; alertType?: string }[],
  options: { oncePerDay?: "delivery_failure" } = {}
): Promise<void> {
  try {
    if (items.length === 0) return;
    const users = await prisma.user.findMany({
      where: { id: { in: items.map((i) => i.userId) }, status: "ACTIVE" },
      select: { id: true, whatsappPhone: true, whatsappVerifiedAt: true, whatsappOptInAt: true, whatsappMutedAlerts: true },
    });
    const ready = new Map(users.filter(isWhatsAppRecipientReady).map((u) => [u.id, normalizeStaffWhatsAppPhone(u.whatsappPhone)!]));
    const muted = new Map(users.map((u) => [u.id, u.whatsappMutedAlerts]));
    if (ready.size === 0) return;
    if (!(await isWhatsAppEnabledForTenant())) return;

    for (const item of items) {
      const to = ready.get(item.userId);
      if (!to) continue;
      if (isWhatsAppAlertMuted(muted.get(item.userId), item.alertType)) continue;
      let claimedAt: Date | null = null;
      if (options.oncePerDay === "delivery_failure") {
        claimedAt = await claimDailyDeliveryFailure(item.userId);
        if (!claimedAt) continue;
      }
      const result = await sendTemplateMessage(to, item.message);
      if (!result.ok) {
        // Template name only — never the number or the message parameters.
        console.error(`[whatsapp] send refused (non-fatal): template=${item.message.templateName}`);
        if (claimedAt) await releaseDailyDeliveryFailure(item.userId, claimedAt);
      }
    }
  } catch (error) {
    console.error(`[whatsapp] dispatch failed (non-fatal): ${error instanceof Error ? error.name : "unknown"}`);
  }
}
