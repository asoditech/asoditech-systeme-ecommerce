import type { NextConfig } from "next";

// Static security headers (Batch 1A hardening), on every route. Nothing here
// depends on the request, so no page is forced dynamic. The CSP holds ONLY
// directives that cannot block this app's own scripts/styles (no script-src,
// no nonce — that is a later, report-only-first step). HSTS: no `preload`;
// `includeSubDomains` only covers subdomains of the host serving it (www —
// the apex redirects there at the Vercel domain level).
export const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // camera=(self): the barcode scanner (getUserMedia).
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  // Google Drive OAuth is a full-page redirect, never a popup.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
];

// Pages whose URL carries a one-time bearer token: never send it as a referrer.
export const TOKEN_PAGE_SOURCES = ["/reinitialiser-mot-de-passe/:path*", "/invitations/:path*"];

const nextConfig: NextConfig = {
  // Pure build-time tree-shaking hint — no runtime behavior change.
  // recharts (used only on Dashboard/Analyses/Rapports) is the one
  // dependency here big enough for this to matter; lucide-react is
  // already in Next's own default optimizePackageImports list.
  experimental: {
    optimizePackageImports: ["recharts"],
  },
  // /platform/sante compares the database's applied migrations with the
  // ones shipped in THIS deployment (src/lib/queries/platform-health.ts):
  // ship the migration folder names with that one route. Text files only.
  outputFileTracingIncludes: {
    "/platform/sante": ["./prisma/migrations/**/migration.sql"],
  },
  // Self-hosted barcode decoder (src/lib/barcode-scanner/decoder.ts): the
  // folder name carries the version, so its files never change in place —
  // cache them for a year instead of revalidating ~1.1 MB on every scan.
  // Rules are applied in order and a later rule overrides the same header
  // key, so the token-page Referrer-Policy comes after the global set.
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      ...TOKEN_PAGE_SOURCES.map((source) => ({ source, headers: [{ key: "Referrer-Policy", value: "no-referrer" }] })),
      {
        source: "/vendor/zxing-wasm-:version/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
