"use server";

import { redirect } from "next/navigation";
import { requireUserForAction } from "@/lib/auth/guards";
import { clearPlatformUnlock, issuePlatformUnlock, platformKeyConfigured, verifyPlatformKey } from "@/lib/auth/platform-access";
import { recordAuditEvent } from "@/lib/audit";
import { actionError, type ActionResult } from "@/actions/types";

/**
 * Platform step-up unlock (docs/adr/0053). Only a platform admin may try;
 * the key itself is never logged or stored — the audit event records only
 * success / failure, in the admin's own tenant.
 */
export async function unlockPlatformAction(
  _prev: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  if (!user.isPlatformAdmin) return actionError("Non autorisé : réservé aux administrateurs de la plateforme.");
  if (!platformKeyConfigured()) {
    return actionError("L'accès plateforme n'est pas configuré sur ce déploiement (PLATFORM_ACCESS_KEY_SHA256).");
  }
  const key = formData.get("key");
  const ok = typeof key === "string" && verifyPlatformKey(key.trim());
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: ok ? "platform.unlock.success" : "platform.unlock.failure",
    entityType: "User",
    entityId: user.id,
  });
  if (!ok) return actionError("Clé d'accès invalide.");
  await issuePlatformUnlock(user.id);
  redirect("/platform");
}

/** Ends the platform step-up for this session (the customer-side login stays). */
export async function lockPlatformAction(): Promise<void> {
  await requireUserForAction();
  await clearPlatformUnlock();
  redirect("/tableau-de-bord");
}
