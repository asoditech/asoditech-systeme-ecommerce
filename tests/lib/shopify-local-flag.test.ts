import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isShopifyIntegrationEnabled } from "@/lib/integrations/shopify/feature-flag";

/**
 * Shopify for LOCAL development (2026-10-13): the kill switch stays exactly
 * as it is (`SHOPIFY_INTEGRATION_ENABLED === "true"`, read at call time); a
 * developer turns it on with `.env.development.local`, which Next.js reads
 * only under `next dev` — never in a production build, never in tests, and
 * git ignores it (`.env*`). Production/Preview keep their own (unset) value.
 */

// @next/env is Next's own loader (a dependency of `next`, not hoisted by pnpm).
// It snapshots process.env on first use, so each case loads a fresh copy.
const nextRequire = createRequire(createRequire(import.meta.url).resolve("next/package.json"));
const freshLoadEnvConfig = () => {
  delete nextRequire.cache[nextRequire.resolve("@next/env")];
  return (nextRequire("@next/env") as {
    loadEnvConfig: (dir: string, dev?: boolean, log?: unknown, forceReload?: boolean) => { parsedEnv?: Record<string, string> };
  }).loadEnvConfig;
};
const silent = { info: () => {}, error: () => {} };

describe("Shopify kill switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [undefined, false],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    ["true", true],
  ])("SHOPIFY_INTEGRATION_ENABLED=%s → enabled %s (only the literal string \"true\")", (value, enabled) => {
    if (value === undefined) vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", undefined as unknown as string);
    else vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", value);
    expect(isShopifyIntegrationEnabled()).toBe(enabled);
  });

  it("a .env.development.local flag reaches `next dev` only — not a production build, not tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "shopify-flag-"));
    try {
      writeFileSync(join(dir, ".env.development.local"), "SHOPIFY_INTEGRATION_ENABLED=true\n");
      const load = (nodeEnv: string, dev: boolean) => {
        vi.unstubAllEnvs();
        vi.stubEnv("NODE_ENV", nodeEnv);
        vi.stubEnv("SHOPIFY_INTEGRATION_ENABLED", undefined as unknown as string);
        return freshLoadEnvConfig()(dir, dev, silent, true).parsedEnv ?? {};
      };
      expect(load("development", true).SHOPIFY_INTEGRATION_ENABLED).toBe("true");
      expect(load("production", false).SHOPIFY_INTEGRATION_ENABLED).toBeUndefined();
      expect(load("test", true).SHOPIFY_INTEGRATION_ENABLED).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
