import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Provider-agnostic SSRF host validation, extracted from the WooCommerce
 * integration (Phase 20) during Phase 21 so Shopify can reuse the exact
 * same private/loopback/link-local/reserved-address logic instead of a
 * duplicated copy. See docs/adr/0010-woocommerce-integration.md and
 * docs/adr/0011-shopify-integration.md.
 */
export class InvalidHostError extends Error {}

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 0) return true; // "this network"
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true;
  if (normalized.startsWith("fe80:")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local (fc00::/7)
  if (normalized.startsWith("::ffff:")) {
    const embedded = normalized.split(":").pop() ?? "";
    if (isIP(embedded) === 4) return isPrivateOrReservedIPv4(embedded);
  }
  return false;
}

export function isPrivateOrReservedIP(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateOrReservedIPv4(ip);
  if (version === 6) return isPrivateOrReservedIPv6(ip);
  return true; // not a recognizable IP — treat as unsafe
}

/**
 * Resolves `hostname` (or uses it directly if it's already a literal IP)
 * and throws InvalidHostError if any resolved address is private,
 * loopback, link-local, or otherwise reserved. Re-run this immediately
 * before every outbound request, not just at save time — DNS can change
 * between the two ("DNS rebinding").
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new InvalidHostError("Cette adresse n'est pas accessible depuis le serveur.");
  }

  const literalVersion = isIP(hostname);
  const addresses = literalVersion
    ? [hostname]
    : await lookup(hostname, { all: true })
        .then((results) => results.map((r) => r.address))
        .catch(() => {
          throw new InvalidHostError("Impossible de résoudre cette adresse.");
        });

  if (addresses.length === 0 || addresses.some((addr) => isPrivateOrReservedIP(addr))) {
    throw new InvalidHostError("Cette adresse n'est pas autorisée.");
  }
}
