import { getCurrentUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { env } from "@/lib/env";
import { startGoogleOAuth, isGoogleDriveConfigured } from "@/lib/backup/google-drive-service";

/**
 * Kicks off the Google Drive OAuth flow for the CURRENT authenticated
 * tenant (Backup Phase 2 — docs/adr/0034 §"Phase 2"). The state token is
 * created bound to this (tenant, user) and stored server-side; the browser
 * only ever carries the opaque state string.
 *
 * `settings.manage` (OWNER / ADMIN) only. Under `(protected)` so the proxy
 * already blocks a no-session request — this re-checks anyway.
 */
export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  const back = `${env.APP_URL.replace(/\/$/, "")}/parametres/sauvegarde`;
  if (!user) return Response.redirect(`${env.APP_URL.replace(/\/$/, "")}/connexion`, 302);
  if (!hasPermission(user.role, "settings.manage")) {
    return Response.redirect(`${back}?google=forbidden`, 302);
  }
  if (!isGoogleDriveConfigured()) {
    return Response.redirect(`${back}?google=unconfigured`, 302);
  }

  try {
    const { authUrl } = await startGoogleOAuth({ tenantId: user.tenantId, userId: user.id });
    return Response.redirect(authUrl, 302);
  } catch {
    return Response.redirect(`${back}?google=error`, 302);
  }
}
