import "server-only";

import { redirect } from "next/navigation";
import type { CurrentUser } from "@/lib/auth/session";
import type { TenantCapability } from "@/lib/tenant/business-mode";

/**
 * Tenant-capability guards — docs/adr/0041-tenant-business-mode.md.
 *
 * Most Offline surfaces are already closed by effective permissions (a gated
 * permission is dropped when its capability is off, for every role). These
 * guards cover the surfaces that have NO permission of their own — a form field,
 * a tab, a Server Action gated only by `products.edit` / `users.manage` — so
 * "Online-only tenants behave exactly like the previous system" is enforced on
 * the server for them too, never by hiding a control.
 */

type CapabilityUser = Pick<CurrentUser, "capabilities">;

export function hasCapability(user: CapabilityUser, capability: TenantCapability): boolean {
  return user.capabilities.has(capability);
}

/** Page-level: redirects to /acces-refuse (the user IS authenticated; the space just doesn't include this). */
export function requireCapability(user: CapabilityUser, capability: TenantCapability): void {
  if (!hasCapability(user, capability)) redirect("/acces-refuse");
}

/** Server-Action-level: throws, like `requirePermissionForAction`. */
export function requireCapabilityForAction(user: CapabilityUser, capability: TenantCapability): void {
  if (!hasCapability(user, capability)) {
    throw new Error("Non autorisé : cette fonctionnalité n'est pas activée pour votre espace.");
  }
}
