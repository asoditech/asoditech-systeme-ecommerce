import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isWhatsAppConfigured } from "@/lib/whatsapp/client";
import { WHATSAPP_TEMPLATE_LANGUAGE, type WhatsAppTemplateMessage } from "@/lib/whatsapp/templates";
import { isWhatsAppAlertMuted } from "@/lib/whatsapp/alert-types";
import { getEnabledWhatsAppTemplates } from "@/lib/whatsapp/template-config";
import { IGNORE_REASONS, isTemplateSendable } from "@/lib/whatsapp/outbox-rules";
import { processDueWhatsAppOutbox, type OutboxPayload } from "@/lib/whatsapp/outbox";
import {
  claimDailyDeliveryFailure,
  isWhatsAppEnabledForTenant,
  isWhatsAppRecipientReady,
  loadCompanyDisabledWhatsAppAlerts,
  releaseDailyDeliveryFailure,
  WHATSAPP_RECIPIENT_SELECT,
} from "@/lib/whatsapp/recipients";

export { isWhatsAppEnabledForTenant, isWhatsAppRecipientReady, type WhatsAppRecipientState } from "@/lib/whatsapp/recipients";

/**
 * WhatsApp delivery of a staff alert — docs/adr/0058 (+ 2026-10-16 outbox
 * addendum).
 *
 * Called by `notify()` / `notifyWhatsAppOnly()` (and the delivery-failure
 * bundler) with users they ALREADY selected — same tenant, ACTIVE,
 * effective permission, location scope (ADR 0056). This module only
 * NARROWS that set; it never adds a recipient:
 *   - the tenant enabled WhatsApp (Integration WHATSAPP = CONNECTE) and the
 *     central sender is configured — otherwise nothing is recorded at all;
 *   - the user verified their own number and explicitly opted in;
 *   - the company did not switch the category off
 *     (`BusinessSettings.whatsappDisabledAlerts`), the user did not mute it
 *     (`User.whatsappMutedAlerts`).
 * Each remaining (event, recipient) becomes ONE `whatsapp_outbox` row keyed
 * by the event's dedupe key — a replay inserts nothing (`skipDuplicates`).
 * A row whose template is not approved/enabled is recorded IGNORE with a
 * configuration reason (visible to the admin), never sent. The new rows are
 * then sent right away (src/lib/whatsapp/outbox.ts), and a few other due
 * retries of the same tenant ride along. Best-effort: never throws, runs
 * after the business transaction commits.
 */

/** How many OTHER due rows of the tenant an enqueue also processes. */
const OPPORTUNISTIC_RETRY_LIMIT = 5;

export interface WhatsAppDispatchItem {
  userId: string;
  message: WhatsAppTemplateMessage;
  alertType?: string;
  /** The event's idempotency key (notify()'s dedupeKey, or the bundle's). */
  dedupeKey: string;
}

export async function sendWhatsAppToUsers(
  items: WhatsAppDispatchItem[],
  options: { oncePerDay?: "delivery_failure" } = {}
): Promise<void> {
  try {
    if (items.length === 0) return;
    if (!isWhatsAppConfigured()) return;
    const users = await prisma.user.findMany({
      where: { id: { in: items.map((i) => i.userId) }, status: "ACTIVE" },
      select: WHATSAPP_RECIPIENT_SELECT,
    });
    const ready = new Set(users.filter(isWhatsAppRecipientReady).map((u) => u.id));
    const muted = new Map(users.map((u) => [u.id, u.whatsappMutedAlerts]));
    if (ready.size === 0) return;
    if (!(await isWhatsAppEnabledForTenant())) return;
    const companyDisabled = await loadCompanyDisabledWhatsAppAlerts();
    const enabledTemplates = getEnabledWhatsAppTemplates();

    const rows: Prisma.WhatsAppOutboxMessageCreateManyInput[] = [];
    const claims: { userId: string; claimedAt: Date; dedupeKey: string }[] = [];
    for (const item of items) {
      if (!ready.has(item.userId)) continue;
      if (isWhatsAppAlertMuted(muted.get(item.userId), item.alertType)) continue;
      if (isWhatsAppAlertMuted(companyDisabled, item.alertType)) continue;
      const sendable = isTemplateSendable(item.message.templateName, enabledTemplates);
      let dedupeKey = item.dedupeKey;
      const payload: OutboxPayload = {
        language: WHATSAPP_TEMPLATE_LANGUAGE,
        parameters: item.message.parameters,
        ...(item.message.buttonParameter ? { buttonParameter: item.message.buttonParameter } : {}),
      };
      if (sendable && options.oncePerDay === "delivery_failure") {
        // One summary per recipient per UTC day (V1 rule): the user-row claim
        // decides; its timestamp makes the row key unique per claim, so a
        // summary that definitively failed (claim released) lets a later one go.
        const claimedAt = await claimDailyDeliveryFailure(item.userId);
        if (!claimedAt) continue;
        dedupeKey = `${item.dedupeKey}:${claimedAt.toISOString()}`;
        payload.dailyClaimAt = claimedAt.toISOString();
        claims.push({ userId: item.userId, claimedAt, dedupeKey });
      }
      rows.push({
        userId: item.userId,
        alertType: item.alertType ?? null,
        dedupeKey,
        templateName: item.message.templateName,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: sendable ? "EN_ATTENTE" : "IGNORE",
        lastError: sendable ? null : IGNORE_REASONS.templateNotEnabled(item.message.templateName),
        // App clock, so the immediate claim below (same clock) sees the row as due.
        nextAttemptAt: new Date(),
      });
    }
    if (rows.length === 0) return;

    const created = await prisma.whatsAppOutboxMessage.createManyAndReturn({
      data: rows,
      skipDuplicates: true,
      select: { id: true, status: true, dedupeKey: true, userId: true },
    });
    // A claim whose row was not inserted (its key is unique per claim, so this
    // should never happen): give the day back rather than lose it.
    const inserted = new Set(created.map((r) => `${r.userId}|${r.dedupeKey}`));
    for (const c of claims) {
      if (!inserted.has(`${c.userId}|${c.dedupeKey}`)) await releaseDailyDeliveryFailure(c.userId, c.claimedAt);
    }

    const fresh = created.filter((r) => r.status === "EN_ATTENTE").map((r) => r.id);
    if (fresh.length > 0) await processDueWhatsAppOutbox({ onlyIds: fresh, limit: fresh.length });
    await processDueWhatsAppOutbox({ limit: OPPORTUNISTIC_RETRY_LIMIT });
  } catch (error) {
    console.error(`[whatsapp] dispatch failed (non-fatal): ${error instanceof Error ? error.name : "unknown"}`);
  }
}
