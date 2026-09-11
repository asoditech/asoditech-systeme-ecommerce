import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pure build-time tree-shaking hint — no runtime behavior change.
  // recharts (used only on Dashboard/Analyses/Rapports) is the one
  // dependency here big enough for this to matter; lucide-react is
  // already in Next's own default optimizePackageImports list.
  experimental: {
    optimizePackageImports: ["recharts"],
  },
};

export default nextConfig;
