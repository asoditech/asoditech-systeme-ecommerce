import "server-only";

import { redirect } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/session";
import { hasPermission, type Permission } from "@/lib/auth/permissions";

/**
 * Use at the top of protected Server Components / layouts. Redirects to the
 * login page if there is no valid session. This is the real authorization
 * boundary — route protection in `proxy.ts` is only a fast, best-effort
 * redirect and must never be relied upon alone.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/connexion");
  }
  return user;
}

/** Use inside Server Actions to authorize a mutation. Throws instead of redirecting. */
export async function requireUserForAction(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new Error("Non autorisé : session invalide ou expirée.");
  }
  return user;
}

/**
 * Use at the top of a protected page/layout that requires a specific
 * permission. Redirects to a "not authorized" page rather than the login
 * page, since the user IS authenticated — they just can't see this.
 */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!hasPermission(user.role, permission)) {
    redirect("/acces-refuse");
  }
  return user;
}

/**
 * Use inside Server Actions to authorize a mutation against a specific
 * permission. This is the real enforcement point — a user who cannot see a
 * button in the UI must also be rejected here if they call the action
 * directly, e.g. via a crafted request.
 */
export async function requirePermissionForAction(permission: Permission): Promise<CurrentUser> {
  const user = await requireUserForAction();
  if (!hasPermission(user.role, permission)) {
    throw new Error("Non autorisé : permission manquante pour cette action.");
  }
  return user;
}

/**
 * Use at the top of a `/platform` page/layout (Phase 5 —
 * docs/adr/0027-tenant-provisioning.md) — the cross-tenant area that
 * manages OTHER tenants' existence. `isPlatformAdmin` is a flag on `User`,
 * deliberately independent of `role`/RBAC (see the schema comment) —
 * being OWNER of a tenant does not, by itself, grant this.
 */
export async function requirePlatformAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.isPlatformAdmin) {
    redirect("/acces-refuse");
  }
  return user;
}

/** Use inside a `/platform` Server Action. Throws instead of redirecting — see `requirePlatformAdmin`. */
export async function requirePlatformAdminForAction(): Promise<CurrentUser> {
  const user = await requireUserForAction();
  if (!user.isPlatformAdmin) {
    throw new Error("Non autorisé : réservé aux administrateurs de la plateforme.");
  }
  return user;
}
