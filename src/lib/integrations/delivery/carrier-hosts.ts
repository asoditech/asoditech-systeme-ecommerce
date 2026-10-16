import "server-only";

import { DeliveryConfigError } from "./errors";

/**
 * Official carrier hosts — the ONLY hosts a configurable carrier URL may
 * point to (SSRF / credential-exfiltration guard, 2026-10-16 review).
 *
 * Why an allowlist and not just `assertPublicHost`: OzonExpress puts the
 * customer id + API key in the URL path and Aramex puts the full
 * `ClientInfo` (user, password, PIN) in the request body. A tenant-editable
 * base URL pointing at ANY public host would hand those credentials to that
 * host. `assertPublicHost` (private-IP / DNS-rebinding check) still runs
 * before every request on top of this.
 *
 * Every host below comes from the repo's own documentation / fixed config:
 *  - OzonExpress API `api.ozonexpress.ma` — ADR 0013 « Base URL »;
 *  - OzonExpress portal `client.ozoneexpress.ma` (sic, two « e ») — ADR 0015,
 *    the owner-documented PDF portal (default of `portalBaseUrl`);
 *  - Aramex `ws.aramex.net` (live) + `ws.dev.aramex.net` (sandbox) —
 *    ADR 0028 / aramex client constants;
 *  - Sendit labels `app.sendit.ma` — official spec
 *    (https://app.sendit.ma/docs/api-docs.json): `servers` and the
 *    `labelUrl` / `fileUrl` examples (`https://app.sendit.ma/signed-files/…`).
 * Ameex and Sendit API bases are hard-coded constants with no tenant
 * override, so they need no entry here.
 */
export const OZONEXPRESS_API_HOSTS: readonly string[] = ["api.ozonexpress.ma"];
export const OZONEXPRESS_PORTAL_HOSTS: readonly string[] = ["client.ozoneexpress.ma"];
export const ARAMEX_API_HOSTS: readonly string[] = ["ws.aramex.net", "ws.dev.aramex.net"];
export const SENDIT_LABEL_HOSTS: readonly string[] = ["app.sendit.ma"];

/**
 * Test-only mock hosts, accepted ONLY when NODE_ENV === "test" (vitest).
 * Existing fixtures point mocked carriers at the IANA documentation host
 * (tests/helpers/fake-ozonexpress.ts) or its literal IP
 * (tests/lib/aramex-client-once.test.ts); fetch is stubbed there. Never
 * accepted in development or production.
 */
const TEST_ONLY_HOSTS: readonly string[] = ["example.com", "93.184.216.34"];

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/** True when `hostname` is exactly one of `allowed` (no subdomain wildcard). */
export function isAllowedCarrierHost(hostname: string, allowed: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (allowed.includes(host)) return true;
  return process.env.NODE_ENV === "test" && TEST_ONLY_HOSTS.includes(host);
}

/** True for an absolute `https:` URL on one of `allowed` hosts (no userinfo, default port). */
export function isAllowedCarrierUrl(raw: unknown, allowed: readonly string[]): boolean {
  if (typeof raw !== "string" || raw.trim() === "") return false;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  return isAllowedCarrierHost(url.hostname, allowed);
}

/**
 * Validates a configurable carrier base URL BEFORE any request: absolute,
 * `https:`, no credentials in it, default port, host on the allowlist.
 * Throws a DeliveryConfigError with a fixed French message (the URL itself
 * is never echoed — it can embed credentials).
 */
export function assertAllowedCarrierBaseUrl(raw: string, allowed: readonly string[], carrierName: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DeliveryConfigError(`L'URL de base ${carrierName} configurée est invalide.`);
  }
  if (url.protocol !== "https:") {
    throw new DeliveryConfigError(`L'URL de base ${carrierName} doit utiliser HTTPS.`);
  }
  if (url.username || url.password || (url.port && url.port !== "443") || !isAllowedCarrierHost(url.hostname, allowed)) {
    throw new DeliveryConfigError(
      `L'URL de base ${carrierName} configurée n'est pas un hôte officiel du transporteur (${allowed.join(", ")}).`
    );
  }
  return url;
}
