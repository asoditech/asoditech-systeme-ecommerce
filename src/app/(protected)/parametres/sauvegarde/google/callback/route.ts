import { getCurrentUser } from "@/lib/auth/session";
import { hasPermission } from "@/lib/auth/permissions";
import { env } from "@/lib/env";
import { recordAuditEvent } from "@/lib/audit";
import { runWithTenant } from "@/lib/tenant/context";
import { completeGoogleOAuth, OAuthStateError } from "@/lib/backup/google-drive-service";
import { GoogleDriveAuthError, GoogleDriveConfigError } from "@/lib/backup/google-drive";

/**
 * Google OAuth redirect target (Backup Phase 2 — docs/adr/0034 §"Phase 2").
 *
 * Security: the tenant is taken ONLY from the authenticated session, never
 * from the query string. The `state` is looked up server-side and must be
 * bound to exactly this (tenant, user) and unexpired; it is single-use.
 * `code` is exchanged server-side; no token ever reaches the browser.
 */
export async function GET(request: Request): Promise<Response> {
  const base = env.APP_URL.replace(/\/$/, "");
  const back = `${base}/parametres/sauvegarde`;

  const user = await getCurrentUser();
  if (!user) return Response.redirect(`${base}/connexion`, 302);
  if (!hasPermission(user.role, "settings.manage")) return Response.redirect(`${back}?google=forbidden`, 302);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError || !code || !state) {
    return Response.redirect(`${back}?google=${oauthError === "access_denied" ? "denied" : "error"}`, 302);
  }

  try {
    await completeGoogleOAuth({ tenantId: user.tenantId, userId: user.id, code, rawState: state });
    return Response.redirect(`${back}?google=connected`, 302);
  } catch (err) {
    const reason =
      err instanceof OAuthStateError ? "state" : err instanceof GoogleDriveAuthError ? "denied" : "error";
    await runWithTenant(user.tenantId, "backup:drive", () =>
      recordAuditEvent({
        actorType: "USER",
        actorUserId: user.id,
        action: "backup.drive_operation_failed",
        entityType: "GoogleDriveConnection",
        entityId: user.tenantId,
        metadata: { operation: "connect", reason },
      })
    ).catch(() => {});
    if (err instanceof OAuthStateError) return Response.redirect(`${back}?google=state`, 302);
    if (err instanceof GoogleDriveAuthError) return Response.redirect(`${back}?google=denied`, 302);
    if (err instanceof GoogleDriveConfigError) return Response.redirect(`${back}?google=unconfigured`, 302);
    return Response.redirect(`${back}?google=error`, 302);
  }
}
