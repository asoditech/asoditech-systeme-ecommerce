import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ENFORCED_FEATURE_KEYS, FEATURE_KEYS } from "@/lib/entitlements/catalogue";

/**
 * The plan editor (/platform/plans) labels every feature NOT in
 * ENFORCED_FEATURE_KEYS as « indicatif » (display only). This keeps that
 * list honest: it must equal the set of keys the code really checks with
 * requireEntitlement / checkEntitlement.
 */

const root = path.resolve(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("feature entitlement enforcement", () => {
  it("ENFORCED_FEATURE_KEYS = exactly the keys passed to requireEntitlement / checkEntitlement", () => {
    const checked = new Set<string>();
    for (const file of sourceFiles(root)) {
      if (file.includes(`${path.sep}lib${path.sep}entitlements${path.sep}`)) continue;
      for (const m of readFileSync(file, "utf8").matchAll(/(?:requireEntitlement|checkEntitlement)\([^,)]+,\s*"([a-zA-Z]+)"\)/g)) checked.add(m[1]);
    }
    expect([...checked].sort()).toEqual([...ENFORCED_FEATURE_KEYS].sort());
    for (const key of ENFORCED_FEATURE_KEYS) expect(FEATURE_KEYS).toContain(key);
  });
});
