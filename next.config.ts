import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pure build-time tree-shaking hint — no runtime behavior change.
  // recharts (used only on Dashboard/Analyses/Rapports) is the one
  // dependency here big enough for this to matter; lucide-react is
  // already in Next's own default optimizePackageImports list.
  experimental: {
    optimizePackageImports: ["recharts"],
  },
  // Self-hosted barcode decoder (src/lib/barcode-scanner/decoder.ts): the
  // folder name carries the version, so its files never change in place —
  // cache them for a year instead of revalidating ~1.1 MB on every scan.
  async headers() {
    return [
      {
        source: "/vendor/zxing-wasm-:version/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

export default nextConfig;
