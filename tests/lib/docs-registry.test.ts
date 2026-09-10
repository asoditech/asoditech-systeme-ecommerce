import { describe, expect, it } from "vitest";
import { ALL_ARTICLES, getArticleBySlug, articleHref } from "@/lib/docs/registry";
import { DOC_CATEGORIES } from "@/lib/docs/categories";
import { PERMISSIONS } from "@/lib/auth/permissions";

/**
 * Structural integrity of the Documentation/Demo Center registry — see
 * docs/CONTRIBUTING.md. These are the checks a broken/duplicated/dangling
 * article would fail, independent of prose quality.
 */
describe("Documentation registry", () => {
  it("has at least one article", () => {
    expect(ALL_ARTICLES.length).toBeGreaterThan(0);
  });

  it("has no duplicate slugs", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const a of ALL_ARTICLES) {
      if (seen.has(a.slug)) duplicates.push(a.slug);
      seen.add(a.slug);
    }
    expect(duplicates).toEqual([]);
  });

  it("every article's slug is prefixed by its own category id", () => {
    const offenders = ALL_ARTICLES.filter((a) => !a.slug.startsWith(`${a.category}/`));
    expect(offenders.map((a) => a.slug)).toEqual([]);
  });

  it("every article belongs to a real category", () => {
    const validIds = new Set(DOC_CATEGORIES.map((c) => c.id));
    const offenders = ALL_ARTICLES.filter((a) => !validIds.has(a.category));
    expect(offenders.map((a) => a.slug)).toEqual([]);
  });

  it("every `related` slug resolves to a real article", () => {
    const dangling: string[] = [];
    for (const a of ALL_ARTICLES) {
      for (const slug of a.related ?? []) {
        if (!getArticleBySlug(slug)) dangling.push(`${a.slug} -> ${slug}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("every article's permission (if set) is a real permission constant", () => {
    const valid = new Set<string>(PERMISSIONS);
    const offenders = ALL_ARTICLES.filter((a) => a.permission && !valid.has(a.permission));
    expect(offenders.map((a) => a.slug)).toEqual([]);
  });

  it("every article has a tagline and a lastUpdated date", () => {
    const offenders = ALL_ARTICLES.filter((a) => !a.tagline.trim() || !a.lastUpdated.trim());
    expect(offenders.map((a) => a.slug)).toEqual([]);
  });

  it("articleHref() round-trips through getArticleBySlug", () => {
    for (const a of ALL_ARTICLES) {
      const href = articleHref(a);
      expect(href).toBe(`/documentation/${a.category}/${a.slug.slice(a.category.length + 1)}`);
    }
  });

  it("every tryNow.href looks like a real internal absolute path", () => {
    const offenders = ALL_ARTICLES.filter((a) => a.tryNow && !a.tryNow.href.startsWith("/"));
    expect(offenders.map((a) => a.slug)).toEqual([]);
  });
});
