import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard for a real production incident: a Server Component
 * (src/app/(protected)/commandes/page.tsx) passed an inline
 * `onClick={(e) => ...}` to `next/link`'s `<Link>`. React can only ship a
 * *value* across the server→client boundary, never a function closure —
 * this crashed every request to /commandes with "Event handlers cannot be
 * passed to Client Component props." (digest 4096015769) until fixed by
 * extracting the handler into its own "use client" component
 * (src/components/stop-propagation-link.tsx).
 *
 * TypeScript and `next build` do not catch this — it only throws when a
 * real request actually renders the branch. This static scan is the
 * cheapest guard that does: no Server Component file (no "use client" in
 * its first few lines) may contain an inline `on<Event>={` JSX prop.
 */

const EVENT_PROP_RE = /\bon[A-Z][a-zA-Z]*=\{/;
const SCAN_ROOTS = ["src/app", "src/components"];
const SKIP_DIRS = new Set(["ui", "node_modules"]);

function isClientFile(content: string): boolean {
  const head = content.split("\n", 5).join("\n");
  return head.includes('"use client"') || head.includes("'use client'");
}

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...collectTsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Server Components never pass inline event-handler props", () => {
  const offenders: { file: string; line: number; snippet: string }[] = [];

  for (const root of SCAN_ROOTS) {
    for (const file of collectTsxFiles(join(process.cwd(), root))) {
      const content = readFileSync(file, "utf-8");
      if (isClientFile(content)) continue;
      content.split("\n").forEach((line, i) => {
        if (EVENT_PROP_RE.test(line)) {
          offenders.push({ file, line: i + 1, snippet: line.trim() });
        }
      });
    }
  }

  it("found zero offending files (see the comment above for why this matters)", () => {
    expect(offenders).toEqual([]);
  });
});
