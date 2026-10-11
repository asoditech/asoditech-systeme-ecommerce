import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * Batch 1A — static security headers (next.config.ts). Resolves headers the
 * way Next does for these rules: every matching rule applies in order, and
 * a later rule overrides an earlier one for the same header key.
 */

type Rule = { source: string; headers: { key: string; value: string }[] };

function matches(source: string, pathname: string): boolean {
  // Enough of path-to-regexp for the sources used here: ":name*" = rest of path, ":name" = one segment.
  const pattern = source
    .split("/")
    .map((seg) => {
      if (seg === ":path*") return "(?:.*)";
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)\\\*/g, "(?:.*)").replace(/:(\w+)/g, "[^/]+");
    })
    .join("/");
  return new RegExp(`^${pattern.replace(/\/\(\?:\.\*\)$/, "(?:/.*)?")}$`).test(pathname);
}

async function headersFor(pathname: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers!()) as Rule[];
  const out: Record<string, string> = {};
  for (const rule of rules) if (matches(rule.source, pathname)) for (const h of rule.headers) out[h.key] = h.value;
  return out;
}

const EXPECTED = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
};

describe("static security headers", () => {
  it.each(["/", "/connexion", "/tableau-de-bord", "/commandes/abc", "/api/webhooks/shopify", "/_next/static/chunks/x.js"])(
    "sends the full static set on %s",
    async (pathname) => {
      expect(await headersFor(pathname)).toMatchObject(EXPECTED);
    }
  );

  it("token pages use Referrer-Policy: no-referrer (overriding the global value)", async () => {
    for (const p of ["/reinitialiser-mot-de-passe/abc123", "/invitations/xyz789"]) {
      const h = await headersFor(p);
      expect(h["Referrer-Policy"]).toBe("no-referrer");
      expect(h["X-Frame-Options"]).toBe("DENY");
    }
    expect((await headersFor("/scan/abc"))["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("keeps the ZXing vendor immutable cache header, alongside the security set", async () => {
    const h = await headersFor("/vendor/zxing-wasm-3.1.3/zxing_reader.wasm");
    expect(h["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect((await headersFor("/connexion"))["Cache-Control"]).toBeUndefined();
  });

  it("introduces no script/style CSP, no nonce, no unsafe-* and no HSTS preload", async () => {
    const rules = (await nextConfig.headers!()) as Rule[];
    const all = JSON.stringify(rules);
    expect(all).not.toMatch(/script-src|style-src|default-src|nonce|unsafe-inline|unsafe-eval|Report-Only|preload/);
    const proxy = readFileSync(path.resolve(import.meta.dirname, "../../src/proxy.ts"), "utf8");
    expect(proxy).not.toMatch(/nonce|Content-Security-Policy/);
  });
});

describe("« Sécurité du compte » card", () => {
  it("is rendered on the user's own settings page and wired to logoutAllSessionsAction", () => {
    const page = readFileSync(path.resolve(import.meta.dirname, "../../src/app/(protected)/parametres/notifications/page.tsx"), "utf8");
    const card = readFileSync(path.resolve(import.meta.dirname, "../../src/components/settings/account-security-card.tsx"), "utf8");
    expect(page).toContain("<AccountSecurityCard />");
    expect(card).toContain("action={logoutAllSessionsAction}");
    expect(card).toContain("ConfirmActionButton");
    expect(card).toContain("Se déconnecter de toutes les sessions");
  });
});
