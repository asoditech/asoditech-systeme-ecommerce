import "server-only";

import { prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";
import { hashToken } from "@/lib/auth/tokens";

/**
 * Shared "is this token still usable" check for both an Invitation and a
 * PasswordResetToken (Phase 5 — docs/adr/0027-tenant-provisioning.md) —
 * used by BOTH the accept/reset Server Action (which acts on it) and the
 * page component (which previews it before rendering a form at all, so an
 * expired/revoked/already-used link shows a clear error instead of a form
 * that will just fail on submit). Unscoped by necessity: the tenant isn't
 * known until the token itself resolves one.
 */

export async function findUsableInvitation(rawToken: string) {
  const invitation = await runUnscoped("token-lookup:invitation", () =>
    prismaBase.invitation.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { tenant: { select: { status: true } } },
    })
  );
  if (!invitation) return null;
  const usable = invitation.status === "PENDING" && invitation.expiresAt > new Date() && invitation.tenant.status === "ACTIVE";
  return { invitation, usable };
}

export async function findUsablePasswordResetToken(rawToken: string) {
  const resetToken = await runUnscoped("token-lookup:password-reset", () =>
    prismaBase.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: { select: { status: true, email: true } }, tenant: { select: { status: true } } },
    })
  );
  if (!resetToken) return null;
  const usable =
    resetToken.usedAt === null &&
    resetToken.expiresAt > new Date() &&
    resetToken.user.status === "ACTIVE" &&
    resetToken.tenant.status === "ACTIVE";
  return { resetToken, usable };
}
