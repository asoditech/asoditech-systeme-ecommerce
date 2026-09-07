"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, destroyCurrentSession, getCurrentUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { loginSchema } from "@/lib/validation/auth";
import { actionError, type ActionResult } from "@/actions/types";

// Deliberately vague — never reveal whether the failure was "no such
// account" vs "wrong password" (avoids account enumeration).
const INVALID_CREDENTIALS_MESSAGE = "E-mail ou mot de passe incorrect.";

export async function loginAction(
  _prevState: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  // Login runs before the tenant is known, and email is now unique only
  // PER TENANT (docs/adr/0025, Phase 3) — two tenants may each have a user
  // at this address. Every candidate across every tenant is fetched
  // (unscoped), then disambiguated by password: an ACTIVE candidate whose
  // password actually matches identifies both the user AND their tenant.
  // Failure audit events, written with no tenant known, fall to the
  // bootstrap tenant.
  const candidates = await runUnscoped("auth:login", () =>
    prisma.user.findMany({ where: { email: parsed.data.email } })
  );

  let user: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (candidate.status !== "ACTIVE") continue;
    if (await verifyPassword(parsed.data.password, candidate.passwordHash)) {
      user = candidate;
      break;
    }
  }

  if (!user) {
    await recordAuditEvent({
      actorType: "SYSTEM",
      action: "user.login.failure",
      entityType: "User",
      // Only attributable to a specific account when the email resolved to
      // exactly one candidate — with several (across tenants), which one
      // the attempt was "for" is ambiguous by design.
      entityId: candidates.length === 1 ? candidates[0].id : "unknown",
      metadata: { email: parsed.data.email },
    });
    return actionError(INVALID_CREDENTIALS_MESSAGE);
  }

  // Password verified — the rest runs pinned to this user's own tenant.
  await runWithTenant(user.tenantId, "auth:login", async () => {
    await createSession(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "user.login.success",
      entityType: "User",
      entityId: user.id,
    });
  });

  redirect("/tableau-de-bord");
}

export async function logoutAction(): Promise<void> {
  const user = await getCurrentUser();
  if (user) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: user.id,
      action: "user.logout",
      entityType: "User",
      entityId: user.id,
    });
  }
  await destroyCurrentSession();
  redirect("/connexion");
}
