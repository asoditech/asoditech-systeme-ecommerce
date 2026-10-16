import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { isWhatsAppConfigured, sendTemplateMessage, type WhatsAppResult } from "@/lib/whatsapp/client";
import { normalizeStaffWhatsAppPhone } from "@/lib/whatsapp/phone";
import { WHATSAPP_TEMPLATE_LANGUAGE } from "@/lib/whatsapp/templates";
import { getEnabledWhatsAppTemplates } from "@/lib/whatsapp/template-config";
import {
  isWhatsAppEnabledForTenant,
  isWhatsAppRecipientReady,
  loadCompanyDisabledWhatsAppAlerts,
  releaseDailyDeliveryFailure,
  WHATSAPP_RECIPIENT_SELECT,
} from "@/lib/whatsapp/recipients";
import {
  decideAfterFailure,
  ignoreReason,
  isOutboxRowExpired,
  OUTBOX_EXPIRED_ERROR,
  OUTBOX_STALE_CLAIM_MS,
  type OutboxStatus,
} from "@/lib/whatsapp/outbox-rules";

/**
 * Durable staff-WhatsApp outbox — docs/adr/0058 addendum (2026-10-16).
 *
 * `whatsapp_outbox` holds one row per (business event, recipient), keyed by
 * the event's dedupe key: enqueueing is idempotent (unique
 * tenantId+userId+dedupeKey, `skipDuplicates`). This module SENDS rows:
 *
 *  - claim: a conditional `updateMany` (EN_ATTENTE and due, or an EN_COURS
 *    claim older than OUTBOX_STALE_CLAIM_MS) → EN_COURS, attempts + 1.
 *    Postgres re-evaluates the WHERE under the row lock, so of two
 *    concurrent processors exactly one gets count = 1 — the other skips.
 *  - re-check at send time (the facts may have changed since enqueue):
 *    template still sendable, tenant switch on, category not disabled by
 *    the company, recipient still ACTIVE + verified + opted in, not muted.
 *    Otherwise IGNORE with the reason. The number is read from the user's
 *    profile now — never stored in the outbox.
 *  - send through src/lib/whatsapp/client.ts, then ENVOYE / EN_ATTENTE
 *    (backoff) / ECHEC per outbox-rules.ts.
 *
 * Never throws: a failure is logged (row id + template only) and the
 * business action that triggered the alert is never affected. Every query
 * runs on the tenant-scoped client — callers without a session (cron) wrap
 * the call in `runWithTenant` (`processDueWhatsAppOutbox({ tenantId })`).
 */

export interface OutboxPayload {
  language: string;
  parameters: string[];
  buttonParameter?: string;
  /** Delivery-failure daily bundle: the user-row claim this row holds (ISO). */
  dailyClaimAt?: string;
}

export function parseOutboxPayload(value: Prisma.JsonValue): OutboxPayload {
  const v = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    language: typeof v.language === "string" ? v.language : WHATSAPP_TEMPLATE_LANGUAGE,
    parameters: Array.isArray(v.parameters) ? v.parameters.filter((p): p is string => typeof p === "string") : [],
    ...(typeof v.buttonParameter === "string" ? { buttonParameter: v.buttonParameter } : {}),
    ...(typeof v.dailyClaimAt === "string" ? { dailyClaimAt: v.dailyClaimAt } : {}),
  };
}

export interface OutboxRunSummary {
  sent: number;
  retrying: number;
  failed: number;
  ignored: number;
}

const emptySummary = (): OutboxRunSummary => ({ sent: 0, retrying: 0, failed: 0, ignored: 0 });

/** Rows a processor may claim now. */
function claimableWhere(now: Date): Prisma.WhatsAppOutboxMessageWhereInput {
  return {
    OR: [
      { status: "EN_ATTENTE", nextAttemptAt: { lte: now } },
      { status: "EN_COURS", updatedAt: { lt: new Date(now.getTime() - OUTBOX_STALE_CLAIM_MS) } },
    ],
  };
}

interface SendContext {
  /** A person clicked « Réessayer »: an old alert may be sent on purpose. */
  manualRetry?: boolean;
  tenantEnabled: boolean;
  companyDisabled: string[];
  enabledTemplates: Set<string>;
}

async function loadSendContext(): Promise<SendContext> {
  const [tenantEnabled, companyDisabled] = await Promise.all([isWhatsAppEnabledForTenant(), loadCompanyDisabledWhatsAppAlerts()]);
  return { tenantEnabled, companyDisabled, enabledTemplates: getEnabledWhatsAppTemplates() };
}

async function releaseClaimOf(userId: string, payload: OutboxPayload): Promise<void> {
  if (payload.dailyClaimAt) await releaseDailyDeliveryFailure(userId, new Date(payload.dailyClaimAt));
}

/** Claims and sends ONE row. Returns its final status for this pass, or null when another processor holds it / it is not due. */
async function processOne(id: string, ctx: SendContext): Promise<OutboxStatus | null> {
  const now = new Date();
  const claimed = await prisma.whatsAppOutboxMessage.updateMany({
    where: { id, ...claimableWhere(now) },
    data: { status: "EN_COURS", attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) return null;

  const row = await prisma.whatsAppOutboxMessage.findUnique({
    where: { id },
    select: { id: true, userId: true, alertType: true, templateName: true, payload: true, attempts: true, createdAt: true, updatedAt: true, status: true },
  });
  if (!row || row.status !== "EN_COURS") return null;
  const payload = parseOutboxPayload(row.payload);
  // Only the holder of the claim writes the outcome. The claim is
  // identified by `attempts` AND the claim's `updatedAt` (@updatedAt, set by
  // the claim itself): a slow holder whose claim was retaken (stale) can no
  // longer overwrite the new holder's outcome — not even after a manual
  // « Réessayer » reset `attempts` back to the same number (ABA).
  // Returns false when the claim was lost: the caller then writes nothing
  // else (no daily-claim release) and reports no outcome for this pass.
  const finish = async (data: Prisma.WhatsAppOutboxMessageUpdateManyMutationInput): Promise<boolean> =>
    (
      await prisma.whatsAppOutboxMessage.updateMany({
        where: { id, status: "EN_COURS", attempts: row.attempts, updatedAt: row.updatedAt },
        data,
      })
    ).count === 1;

  const user = await prisma.user.findUnique({ where: { id: row.userId }, select: WHATSAPP_RECIPIENT_SELECT });
  const to = user ? normalizeStaffWhatsAppPhone(user.whatsappPhone) : null;
  const reason = ignoreReason({
    templateName: row.templateName,
    enabledTemplates: ctx.enabledTemplates,
    tenantEnabled: ctx.tenantEnabled,
    alertType: row.alertType,
    companyDisabled: ctx.companyDisabled,
    recipientReady: Boolean(user && user.status === "ACTIVE" && isWhatsAppRecipientReady(user) && to),
    userMuted: user?.whatsappMutedAlerts ?? [],
  });
  if (reason) {
    if (!(await finish({ status: "IGNORE", lastError: reason }))) return null;
    await releaseClaimOf(row.userId, payload);
    return "IGNORE";
  }
  // Every automatic pass (first attempt included — a row left EN_ATTENTE
  // for days must not go out stale); only a manual « Réessayer » may send
  // an old alert on purpose.
  if (!ctx.manualRetry && isOutboxRowExpired(row.createdAt, now)) {
    if (!(await finish({ status: "ECHEC", lastError: OUTBOX_EXPIRED_ERROR }))) return null;
    await releaseClaimOf(row.userId, payload);
    return "ECHEC";
  }

  let result: WhatsAppResult;
  try {
    result = await sendTemplateMessage(to!, {
      templateName: row.templateName,
      parameters: payload.parameters,
      ...(payload.buttonParameter ? { buttonParameter: payload.buttonParameter } : {}),
    });
  } catch (error) {
    // The client never throws by contract; a mock or a bug might — treat as transient.
    result = { ok: false, error: error instanceof Error ? error.name : "unknown" };
  }

  if (result.ok) {
    if (!(await finish({ status: "ENVOYE", providerMessageId: result.messageId, sentAt: new Date(), lastError: null }))) {
      console.error(`[whatsapp] outbox claim lost before recording a send: row=${row.id} template=${row.templateName}`);
      return null;
    }
    return "ENVOYE";
  }
  const decision = decideAfterFailure({ attempts: row.attempts, error: result.error, now: new Date() });
  // Row id + template only — never the number or the parameters.
  console.error(`[whatsapp] outbox send failed: row=${row.id} template=${row.templateName} → ${decision.status}`);
  const won = await finish(
    decision.status === "EN_ATTENTE"
      ? { status: "EN_ATTENTE", nextAttemptAt: decision.nextAttemptAt, lastError: decision.lastError }
      : { status: decision.status, lastError: decision.lastError }
  );
  if (!won) return null;
  if (decision.status !== "EN_ATTENTE") await releaseClaimOf(row.userId, payload);
  return decision.status;
}

function tally(summary: OutboxRunSummary, status: OutboxStatus | null): void {
  if (status === "ENVOYE") summary.sent += 1;
  else if (status === "EN_ATTENTE") summary.retrying += 1;
  else if (status === "ECHEC") summary.failed += 1;
  else if (status === "IGNORE") summary.ignored += 1;
}

/**
 * Sends what is due for ONE tenant: `tenantId` given → runs inside
 * `runWithTenant` (cron); omitted → the ambient tenant (the session, or the
 * caller's own directive). `onlyIds` restricts the pass to those rows (the
 * rows an enqueue just created). Sends nothing — and leaves every row as
 * it is — while the central sender is not configured. Never throws.
 */
export async function processDueWhatsAppOutbox(
  options: { tenantId?: string; limit?: number; onlyIds?: string[]; manualRetry?: boolean } = {}
): Promise<OutboxRunSummary> {
  const run = async (): Promise<OutboxRunSummary> => {
    const summary = emptySummary();
    try {
      if (!isWhatsAppConfigured()) return summary;
      const limit = Math.min(Math.max(options.limit ?? 20, 1), 200);
      const ids = options.onlyIds
        ? options.onlyIds.slice(0, limit)
        : (
            await prisma.whatsAppOutboxMessage.findMany({
              where: claimableWhere(new Date()),
              orderBy: { nextAttemptAt: "asc" },
              take: limit,
              select: { id: true },
            })
          ).map((r) => r.id);
      if (ids.length === 0) return summary;
      const ctx = { ...(await loadSendContext()), manualRetry: options.manualRetry === true };
      for (const id of ids) {
        try {
          tally(summary, await processOne(id, ctx));
        } catch (error) {
          console.error(`[whatsapp] outbox row failed (non-fatal): row=${id} ${error instanceof Error ? error.name : "unknown"}`);
        }
      }
    } catch (error) {
      console.error(`[whatsapp] outbox pass failed (non-fatal): ${error instanceof Error ? error.name : "unknown"}`);
    }
    return summary;
  };
  return options.tenantId ? runWithTenant(options.tenantId, "whatsapp-outbox", run) : run();
}

/**
 * Cron entry point: every ACTIVE tenant that has rows due. The tenant list
 * is the only cross-tenant read (bypass client, ids only); each tenant's
 * rows are then processed strictly inside its own `runWithTenant`.
 */
export async function processWhatsAppOutboxForAllTenants(options: { limitPerTenant?: number } = {}): Promise<
  { tenants: number } & OutboxRunSummary
> {
  const total = { tenants: 0, ...emptySummary() };
  try {
    if (!isWhatsAppConfigured()) return total;
    const due = await prismaBase.whatsAppOutboxMessage.findMany({
      where: { ...claimableWhere(new Date()), tenant: { status: "ACTIVE" } },
      distinct: ["tenantId"],
      select: { tenantId: true },
      take: 500,
    });
    for (const { tenantId } of due) {
      const s = await processDueWhatsAppOutbox({ tenantId, limit: options.limitPerTenant ?? 50 });
      total.tenants += 1;
      total.sent += s.sent;
      total.retrying += s.retrying;
      total.failed += s.failed;
      total.ignored += s.ignored;
    }
  } catch (error) {
    console.error(`[whatsapp] outbox cron failed (non-fatal): ${error instanceof Error ? error.name : "unknown"}`);
  }
  return total;
}

/**
 * « Réessayer » on one ECHEC row of the CURRENT tenant (tenant-scoped
 * client: a foreign id is simply not found). Resets the attempt budget and
 * sends right away. The caller checks the permission. Returns the row's
 * status after this pass, or null when it was not an ECHEC row of this tenant.
 */
export async function retryWhatsAppOutboxMessage(id: string): Promise<OutboxStatus | null> {
  const reset = await prisma.whatsAppOutboxMessage.updateMany({
    where: { id, status: "ECHEC" },
    data: { status: "EN_ATTENTE", attempts: 0, nextAttemptAt: new Date(), lastError: null },
  });
  if (reset.count !== 1) return null;
  await processDueWhatsAppOutbox({ onlyIds: [id], manualRetry: true });
  const row = await prisma.whatsAppOutboxMessage.findUnique({ where: { id }, select: { status: true } });
  return row?.status ?? null;
}
