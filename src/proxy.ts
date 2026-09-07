import { NextResponse, type NextRequest } from "next/server";

// Fast, cookie-presence-only redirect. This is NOT the authorization
// boundary — it only exists to avoid flashing protected UI before a full,
// database-backed check runs in `requireUser()`/`requirePermission()`
// (see src/lib/auth/guards.ts) inside each protected layout/page. Never add
// authorization logic here that the server components don't also enforce.
const SESSION_COOKIE = "aec_session";
const PUBLIC_PATHS = new Set(["/connexion", "/mot-de-passe-oublie"]);
// Phase 5 (docs/adr/0027-tenant-provisioning.md): invitation-accept and
// password-reset pages carry the one-time token itself in the URL
// (/invitations/<token>, /reinitialiser-mot-de-passe/<token>) — the token
// IS the auth, so these must stay reachable with no session cookie.
const PUBLIC_PATH_PREFIXES = ["/invitations/", "/reinitialiser-mot-de-passe/"];
const STATIC_ASSET_PATTERN = /\.(?:png|svg|jpg|jpeg|webp|gif|ico)$/i;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    STATIC_ASSET_PATTERN.test(pathname)
  ) {
    return NextResponse.next();
  }

  const hasSessionCookie = request.cookies.has(SESSION_COOKIE);
  if (!hasSessionCookie) {
    const loginUrl = new URL("/connexion", request.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
