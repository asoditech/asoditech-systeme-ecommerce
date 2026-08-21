"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, destroyCurrentSession, getCurrentUser } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
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

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  if (!user || user.status !== "ACTIVE") {
    await recordAuditEvent({
      actorType: "SYSTEM",
      action: "user.login.failure",
      entityType: "User",
      entityId: user?.id ?? "unknown",
      metadata: { email: parsed.data.email },
    });
    return actionError(INVALID_CREDENTIALS_MESSAGE);
  }

  const passwordValid = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!passwordValid) {
    await recordAuditEvent({
      actorType: "SYSTEM",
      action: "user.login.failure",
      entityType: "User",
      entityId: user.id,
    });
    return actionError(INVALID_CREDENTIALS_MESSAGE);
  }

  await createSession(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "user.login.success",
    entityType: "User",
    entityId: user.id,
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
