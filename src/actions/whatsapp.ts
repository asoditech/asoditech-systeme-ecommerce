"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { requirePermissionForAction, requireUserForAction } from "@/lib/auth/guards";
import { isWhatsAppAlertType, nextMutedAlerts } from "@/lib/whatsapp/alert-types";
import { recordAuditEvent } from "@/lib/audit";
import { notifyConnectionError } from "@/lib/notifications";
import { checkWhatsAppSender, isWhatsAppConfigured, sendTemplateMessage } from "@/lib/whatsapp/client";
import { isWhatsAppEnabledForTenant } from "@/lib/whatsapp/dispatch";
import { retryWhatsAppOutboxMessage } from "@/lib/whatsapp/outbox";
import { normalizeStaffWhatsAppPhone } from "@/lib/whatsapp/phone";
import { verificationCodeTemplate } from "@/lib/whatsapp/templates";
import {
  CODE_TTL_MS,
  checkVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
  parsePendingVerification,
  recentSends,
  sendRefusal,
  type PendingVerification,
} from "@/lib/whatsapp/verification";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * WhatsApp critical notifications V1 — docs/adr/0058.
 *
 * 1. Tenant switch (`integrations.manage`): the Integration row WHATSAPP is
 *    only an on/off state — the sender is ONE central ASODITECH account
 *    configured by env vars, no per-tenant credentials. « Activer / Tester
 *    la connexion » reads the configured sending number from Meta (sends
 *    nothing); « Désactiver » is the existing disconnectIntegrationAction.
 * 2. The user's OWN number / verification / opt-in. Every action below
 *    acts on the session user only — there is no userId parameter, so no
 *    one (admin included) can change or opt in another user.
 */

// ---------------------------------------------------------------------------
// 1. Tenant switch
// ---------------------------------------------------------------------------

export async function testWhatsAppConnectionAction(): Promise<ActionResult<{ displayPhoneNumber: string | null }>> {
  const user = await requirePermissionForAction("integrations.manage");
  // No central sender on this server: a platform setup gap, not a tenant
  // connection failure — no ERREUR row, no "integration down" alert to the team.
  if (!isWhatsAppConfigured()) return actionError("Le numéro d'envoi ASODITECH n'est pas configuré sur ce serveur.");
  const result = await checkWhatsAppSender();
  const existing = await prisma.integration.findFirst({ where: { provider: "WHATSAPP" }, select: { id: true } });

  if (!result.ok) {
    const row = existing
      ? await prisma.integration.update({ where: { id: existing.id }, data: { status: "ERREUR", lastError: result.error } })
      : await prisma.integration.create({ data: { provider: "WHATSAPP", status: "ERREUR", lastError: result.error } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "integration.connection_test_failed",
      entityType: "Integration",
      entityId: row.id,
      metadata: { provider: "WHATSAPP" },
    });
    await notifyConnectionError(
      { entityType: "Integration", entityId: row.id, label: "WhatsApp", recipientPermission: "integrations.view" },
      user.id
    );
    revalidatePath("/integrations");
    return actionError(result.error);
  }

  const data = {
    status: "CONNECTE" as const,
    lastError: null,
    lastConnectionCheckAt: new Date(),
    // Non-secret display facts about the central sender, for the card.
    config: { displayPhoneNumber: result.displayPhoneNumber, verifiedName: result.verifiedName },
  };
  const row = existing
    ? await prisma.integration.update({ where: { id: existing.id }, data })
    : await prisma.integration.create({ data: { provider: "WHATSAPP", ...data } });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.connection_test_succeeded",
    entityType: "Integration",
    entityId: row.id,
    metadata: { provider: "WHATSAPP" },
  });
  revalidatePath("/integrations");
  return actionOk({ displayPhoneNumber: result.displayPhoneNumber });
}

// ---------------------------------------------------------------------------
// 2. The user's own number
// ---------------------------------------------------------------------------

async function auditOwn(userId: string, change: string) {
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: userId,
    action: "user.whatsapp_updated",
    entityType: "User",
    entityId: userId,
    metadata: { change },
  });
}

function loadOwn(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, updatedAt: true, whatsappPhone: true, whatsappVerifiedAt: true, whatsappVerification: true },
  });
}

/** Saving a NEW number resets verification and opt-in. */
export async function saveMyWhatsAppNumberAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  const phone = normalizeStaffWhatsAppPhone(String(formData.get("phone") ?? ""));
  if (!phone) {
    return actionError("Numéro WhatsApp invalide.", { phone: ["Exemple : 06 12 34 56 78 ou +212 6 12 34 56 78."] });
  }
  const own = await loadOwn(user.id);
  if (own.whatsappPhone === phone) return actionOk(undefined);

  await prisma.user.update({
    where: { id: user.id },
    data: { whatsappPhone: phone, whatsappVerifiedAt: null, whatsappOptInAt: null, whatsappVerification: Prisma.DbNull },
  });
  await auditOwn(user.id, "number_set");
  revalidatePath("/parametres/notifications");
  return actionOk(undefined);
}

export async function removeMyWhatsAppNumberAction(): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  await prisma.user.update({
    where: { id: user.id },
    data: { whatsappPhone: null, whatsappVerifiedAt: null, whatsappOptInAt: null, whatsappVerification: Prisma.DbNull },
  });
  await auditOwn(user.id, "number_removed");
  revalidatePath("/parametres/notifications");
  return actionOk(undefined);
}

export async function requestMyWhatsAppVerificationAction(): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  const own = await loadOwn(user.id);
  const phone = normalizeStaffWhatsAppPhone(own.whatsappPhone);
  if (!phone) return actionError("Enregistrez d'abord votre numéro WhatsApp.");
  if (own.whatsappVerifiedAt) return actionError("Ce numéro est déjà vérifié.");
  if (!(await isWhatsAppEnabledForTenant())) {
    return actionError("Les notifications WhatsApp ne sont pas activées pour votre entreprise.");
  }

  const now = new Date();
  const previous = parsePendingVerification(own.whatsappVerification);
  const refusal = sendRefusal(previous, now);
  if (refusal) return actionError(refusal);

  const code = generateVerificationCode();
  const pending: PendingVerification = {
    phone,
    codeHash: hashVerificationCode(env.AUTH_SECRET, user.id, phone, code),
    expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
    attempts: 0,
    sends: [...recentSends(previous, now), now.toISOString()],
  };
  // Optimistic: a concurrent request on the same row loses (no double send).
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, updatedAt: own.updatedAt },
    data: { whatsappVerification: pending as unknown as Prisma.InputJsonValue },
  });
  if (count !== 1) return actionError("Une autre demande est en cours. Réessayez.");

  const sent = await sendTemplateMessage(phone, verificationCodeTemplate(code));
  await auditOwn(user.id, sent.ok ? "verification_sent" : "verification_send_failed");
  revalidatePath("/parametres/notifications");
  if (!sent.ok && sent.error === "recipient_not_allowed") {
    return actionError("Mode test WhatsApp : ce numéro ne fait pas partie des destinataires autorisés. Aucun message n'a été envoyé.");
  }
  if (!sent.ok) {
    return actionError(
      "L'envoi du code WhatsApp a échoué. Vérifiez que ce numéro utilise WhatsApp, puis réessayez. Si le problème persiste, contactez votre administrateur."
    );
  }
  return actionOk(undefined);
}

export async function verifyMyWhatsAppCodeAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  const own = await loadOwn(user.id);
  const phone = normalizeStaffWhatsAppPhone(own.whatsappPhone);
  if (!phone) return actionError("Enregistrez d'abord votre numéro WhatsApp.");
  if (own.whatsappVerifiedAt) return actionOk(undefined);

  const pending = parsePendingVerification(own.whatsappVerification);
  const code = String(formData.get("code") ?? "").replace(/\s+/g, "");
  const check = checkVerificationCode(pending, { secret: env.AUTH_SECRET, userId: user.id, phone, code, now: new Date() });

  if (check === "ok") {
    const { count } = await prisma.user.updateMany({
      where: { id: user.id, updatedAt: own.updatedAt },
      data: { whatsappVerifiedAt: new Date(), whatsappVerification: Prisma.DbNull },
    });
    if (count !== 1) return actionError("Une autre demande est en cours. Réessayez.");
    await auditOwn(user.id, "verified");
    revalidatePath("/parametres/notifications");
    return actionOk(undefined);
  }
  if (check === "mismatch" && pending) {
    // Every wrong guess consumes an attempt atomically (optimistic on updatedAt).
    await prisma.user.updateMany({
      where: { id: user.id, updatedAt: own.updatedAt },
      data: { whatsappVerification: { ...pending, attempts: pending.attempts + 1 } as unknown as Prisma.InputJsonValue },
    });
    return actionError("Code incorrect.", { code: ["Code incorrect."] });
  }
  return actionError(
    check === "expired"
      ? "Ce code a expiré. Demandez-en un nouveau."
      : check === "too_many_attempts"
        ? "Trop de tentatives. Demandez un nouveau code."
        : "Aucun code en attente. Demandez un code de vérification."
  );
}

export async function setMyWhatsAppOptInAction(enabled: boolean): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  const own = await loadOwn(user.id);
  if (enabled && (!own.whatsappVerifiedAt || !normalizeStaffWhatsAppPhone(own.whatsappPhone))) {
    return actionError("Vérifiez d'abord votre numéro WhatsApp.");
  }
  await prisma.user.update({ where: { id: user.id }, data: { whatsappOptInAt: enabled ? new Date() : null } });
  await auditOwn(user.id, enabled ? "opt_in" : "opt_out");
  revalidatePath("/parametres/notifications");
  return actionOk(undefined);
}

/**
 * Mutes / unmutes ONE WhatsApp alert type for the session user only (own
 * row, never a user id from the client). In-app and email are unaffected;
 * an unknown type is refused.
 */
export async function setMyWhatsAppAlertMutedAction(type: string, muted: boolean): Promise<ActionResult<{ muted: string[] }>> {
  const user = await requireUserForAction();
  if (!isWhatsAppAlertType(type)) return actionError("Type d'alerte inconnu.");
  const own = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { whatsappMutedAlerts: true } });
  const next = nextMutedAlerts(own.whatsappMutedAlerts, type, muted);
  await prisma.user.update({ where: { id: user.id }, data: { whatsappMutedAlerts: next } });
  await auditOwn(user.id, `${muted ? "alert_muted" : "alert_unmuted"}:${type}`);
  revalidatePath("/parametres/notifications");
  return actionOk({ muted: next });
}

// ---------------------------------------------------------------------------
// 3. Company-level operations (docs/adr/0058 addendum) — `integrations.manage`,
//    the same permission as the tenant switch above.
// ---------------------------------------------------------------------------

/**
 * Switches ONE WhatsApp alert category on/off for the whole company
 * (`BusinessSettings.whatsappDisabledAlerts`). Off = no WhatsApp for that
 * category to anyone of this company; in-app / email unchanged; each user's
 * own mutes are kept. Audited.
 */
export async function setCompanyWhatsAppAlertEnabledAction(
  type: string,
  enabled: boolean
): Promise<ActionResult<{ disabled: string[] }>> {
  const user = await requirePermissionForAction("integrations.manage");
  if (!isWhatsAppAlertType(type)) return actionError("Type d'alerte inconnu.");
  const previous = await prisma.businessSettings.findUnique({ where: { tenantId: user.tenantId }, select: { whatsappDisabledAlerts: true } });
  const before = previous?.whatsappDisabledAlerts ?? [];
  const next = nextMutedAlerts(before, type, !enabled);
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: { whatsappDisabledAlerts: next },
    create: { whatsappDisabledAlerts: next },
    select: { id: true },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "whatsapp.alert_category_updated",
    entityType: "BusinessSettings",
    entityId: settings.id,
    previousValue: { whatsappDisabledAlerts: before },
    newValue: { whatsappDisabledAlerts: next },
    metadata: { type, enabled },
  });
  revalidatePath("/integrations");
  revalidatePath("/parametres/notifications");
  return actionOk({ disabled: next });
}

/**
 * « Réessayer » one WhatsApp alert that ended ECHEC — current tenant only
 * (tenant-scoped client: another company's row is not found). Resets its
 * attempt budget and sends now. Audited (row id + category, never the number).
 */
export async function retryWhatsAppOutboxMessageAction(id: string): Promise<ActionResult<{ status: string }>> {
  const user = await requirePermissionForAction("integrations.manage");
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return actionError("Envoi introuvable.");
  const row = await prisma.whatsAppOutboxMessage.findUnique({ where: { id }, select: { id: true, status: true, alertType: true } });
  if (!row) return actionError("Envoi introuvable.");
  if (row.status !== "ECHEC") return actionError("Seul un envoi en échec peut être réessayé.");
  const status = await retryWhatsAppOutboxMessage(row.id);
  if (!status) return actionError("Cet envoi vient d'être traité ailleurs. Rechargez la page.");
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "whatsapp.outbox_retried",
    entityType: "WhatsAppOutboxMessage",
    entityId: row.id,
    metadata: { alertType: row.alertType, status },
  });
  revalidatePath("/integrations");
  return actionOk({ status });
}
