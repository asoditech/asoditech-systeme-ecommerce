import { describe, expect, it } from "vitest";
import { ALL_ARTICLES } from "@/lib/docs/registry";
import { NAV_GROUPS } from "@/components/layout/sidebar-nav";

/**
 * The "hard requirement" from the Documentation/Demo Center spec: the
 * codebase must not be able to drift away from its own documentation
 * silently. NAV_GROUPS is the real, single source of truth for every
 * user-facing route in the app (src/components/layout/sidebar-nav.tsx) —
 * this test fails, by exact href, the moment a route has zero
 * documentation coverage. See docs/CONTRIBUTING.md.
 */
describe("Documentation coverage (CI guardrail)", () => {
  // /documentation is the Documentation Center's own root nav entry, not a
  // business module — it can't sensibly link to "an article about itself".
  const EXEMPT_HREFS = new Set(["/documentation"]);
  const navHrefs = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href)).filter((h) => !EXEMPT_HREFS.has(h));
  const tryNowHrefs = ALL_ARTICLES.map((a) => a.tryNow?.href).filter((h): h is string => Boolean(h));

  it("NAV_GROUPS is non-empty (sanity check that we're reading the real nav)", () => {
    expect(navHrefs.length).toBeGreaterThan(15);
  });

  it.each(navHrefs)("nav route %s has at least one documentation article that links to it", (href) => {
    const covered = tryNowHrefs.some((h) => h === href || h.startsWith(`${href}/`));
    expect(covered).toBe(true);
  });
});
