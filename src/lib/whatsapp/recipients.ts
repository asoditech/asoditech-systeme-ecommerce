import "server-only";

import { prisma } from "@/lib/prisma";
import { isWhatsAppConfigured } from "@/lib/whatsapp/client";
import { normalizeStaffWhatsAppPhone } from "@/lib/whatsapp/phone";

/**
 * Recipient/tenant facts shared by the dispatcher (enqueue) and the outbox
 * processor (send time) — docs/adr/0058. Everything runs on the
 * tenant-scoped client: the current tenant only.
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

/** Alert categories the current company switched off for WhatsApp (BusinessSettings.whatsappDisabledAlerts). */
export async function loadCompanyDisabledWhatsAppAlerts(): Promise<string[]> {
  const row = await prisma.businessSettings.findFirst({ select: { whatsappDisabledAlerts: true } });
  return row?.whatsappDisabledAlerts ?? [];
}

export const WHATSAPP_RECIPIENT_SELECT = {
  id: true,
  status: true,
  whatsappPhone: true,
  whatsappVerifiedAt: true,
  whatsappOptInAt: true,
  whatsappMutedAlerts: true,
} as const;

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Atomic "first delivery-failure WhatsApp of the UTC day" claim on the
 * user's own row: a conditional UPDATE, so two concurrent bundles cannot
 * both win. Returns the claim time (also part of the outbox dedupe key), or
 * null when another bundle already holds today's claim.
 */
export async function claimDailyDeliveryFailure(userId: string): Promise<Date | null> {
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

/**
 * Gives today's claim back when its summary definitively did not go out
 * (ECHEC / IGNORE), so a later failure summary can still be sent today —
 * the V1 rule. A summary still being retried keeps the claim.
 */
export async function releaseDailyDeliveryFailure(userId: string, claimedAt: Date): Promise<void> {
  await prisma.user.updateMany({
    where: { id: userId, whatsappDeliveryFailureNotifiedAt: claimedAt },
    data: { whatsappDeliveryFailureNotifiedAt: null },
  });
}
