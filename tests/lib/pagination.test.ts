import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  buildListHref,
  clampPage,
  lastPage,
  outOfRangeHref,
  pageWindow,
  parsePage,
  parsePageSize,
} from "@/lib/pagination";
import { DataTablePagination } from "@/components/data-table-pagination";

/**
 * Pure pagination helpers + the shared `DataTablePagination` markup — no
 * database. The five main list pages (/commandes, /produits, /livraison,
 * /livraison/suivi, /stock) opt into « Afficher 10 | 50 | 100 par page ».
 */

describe("parsePage", () => {
  it("accepts positive integers only, else 1", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage(" 7 ")).toBe(7);
    for (const raw of [undefined, null, "", "0", "-2", "1.5", "abc", "1e3", "NaN"]) expect(parsePage(raw)).toBe(1);
    expect(parsePage(["4", "9"])).toBe(4);
  });
});

describe("parsePageSize", () => {
  it("allows only 10 / 50 / 100, default 10", () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([10, 50, 100]);
    expect(DEFAULT_PAGE_SIZE).toBe(10);
    expect(parsePageSize("10")).toBe(10);
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize("100")).toBe(100);
    for (const raw of [undefined, "", "20", "25", "1000", "100000", "-50", "50.0", "abc"]) {
      expect(parsePageSize(raw)).toBe(10);
    }
  });
  it("supports custom options / fallback", () => {
    expect(parsePageSize("25", [25, 75], 25)).toBe(25);
    expect(parsePageSize("10", [25, 75], 25)).toBe(25);
  });
});

describe("lastPage / clampPage", () => {
  it("computes the last page (≥ 1)", () => {
    expect(lastPage(0, 10)).toBe(1);
    expect(lastPage(10, 10)).toBe(1);
    expect(lastPage(11, 10)).toBe(2);
    expect(lastPage(201, 100)).toBe(3);
  });
  it("keeps the page inside [1, last]", () => {
    expect(clampPage(0, 95, 10)).toBe(1);
    expect(clampPage(5, 95, 10)).toBe(5);
    expect(clampPage(11, 95, 10)).toBe(10);
    expect(clampPage(4, 0, 10)).toBe(1);
    expect(clampPage(3, 120, 50)).toBe(3);
    expect(clampPage(4, 120, 50)).toBe(3);
  });
});

describe("pageWindow", () => {
  it("shows first, last, neighbours and ellipses", () => {
    expect(pageWindow(5, 20)).toEqual([1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 20]);
    expect(pageWindow(1, 20)).toEqual([1, 2, "ellipsis-end", 20]);
    expect(pageWindow(20, 20)).toEqual([1, "ellipsis-start", 19, 20]);
  });
  it("never hides a single page behind an ellipsis", () => {
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, "ellipsis-end", 20]);
    expect(pageWindow(17, 20)).toEqual([1, "ellipsis-start", 16, 17, 18, 19, 20]);
  });
  it("lists every page when there are few", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });
  it("clamps an out-of-range current page", () => {
    expect(pageWindow(99, 3)).toEqual([1, 2, 3]);
  });
});

describe("buildListHref / outOfRangeHref", () => {
  const filters = { q: "rouge", status: "CONFIRMEE", page: "4", pageSize: "50", empty: undefined };

  it("keeps every filter and applies the overrides", () => {
    const href = buildListHref("/commandes", filters, { page: 2 });
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/commandes");
    expect(url.searchParams.get("q")).toBe("rouge");
    expect(url.searchParams.get("status")).toBe("CONFIRMEE");
    expect(url.searchParams.get("pageSize")).toBe("50");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.has("empty")).toBe(false);
  });

  it("a page-size change resets the page and keeps the filters", () => {
    const url = new URL(buildListHref("/commandes", filters, { page: null, pageSize: 100 }), "http://x");
    expect(url.searchParams.has("page")).toBe(false);
    expect(url.searchParams.get("pageSize")).toBe("100");
    expect(url.searchParams.get("q")).toBe("rouge");
  });

  it("keeps another table's cursor on a shared route", () => {
    const url = new URL(
      buildListHref("/livraison", { sq: "x", page: "3", aexp: "2", aexpPageSize: "50" }, { aexp: null, aexpPageSize: 100 }),
      "http://x"
    );
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("sq")).toBe("x");
    expect(url.searchParams.has("aexp")).toBe(false);
    expect(url.searchParams.get("aexpPageSize")).toBe("100");
  });

  it("appends the hash and handles no params", () => {
    expect(buildListHref("/stock", {}, {})).toBe("/stock");
    expect(buildListHref("/stock", {}, { page: 2 }, "#t")).toBe("/stock?page=2#t");
  });

  it("redirects past-the-end pages to the last page only when there are rows", () => {
    expect(outOfRangeHref({ page: 5, total: 40, pageSize: 10, basePath: "/stock", searchParams: { q: "a", page: "5" } })).toBe(
      "/stock?q=a&page=4"
    );
    expect(outOfRangeHref({ page: 4, total: 40, pageSize: 10, basePath: "/stock", searchParams: {} })).toBeNull();
    expect(outOfRangeHref({ page: 9, total: 0, pageSize: 10, basePath: "/stock", searchParams: {} })).toBeNull();
    expect(
      outOfRangeHref({ page: 3, total: 11, pageSize: 10, basePath: "/livraison", searchParams: { aexp: "3" }, pageParam: "aexp" })
    ).toBe("/livraison?aexp=2");
  });
});

describe("DataTablePagination", () => {
  type Props = Parameters<typeof DataTablePagination>[0];
  const render = (props: Partial<Props>) =>
    renderToStaticMarkup(
      createElement(DataTablePagination, {
        page: 1,
        pageSize: 10,
        total: 200,
        basePath: "/commandes",
        searchParams: { q: "rouge", status: "CONFIRMEE" },
        pageSizeOptions: PAGE_SIZE_OPTIONS,
        ...props,
      })
    );
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

  it("wraps the controls in a labelled nav and marks the current page", () => {
    const html = render({ page: 5 });
    expect(html).toContain('<nav aria-label="Pagination"');
    expect(html).toMatch(/aria-current="page"[^>]*>5</);
    expect(html).toContain("41–50 sur 200");
    expect(html).toContain("…");
  });

  it("disables Précédent on the first page and Suivant on the last", () => {
    const first = render({ page: 1 });
    expect(first).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Page précédente"|<button[^>]*aria-label="Page précédente"[^>]*disabled=""/);
    expect(first).toMatch(/<a[^>]*aria-label="Page suivante"/);
    const last = render({ page: 20 });
    expect(last).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Page suivante"|<button[^>]*aria-label="Page suivante"[^>]*disabled=""/);
    expect(last).toMatch(/<a[^>]*aria-label="Page précédente"/);
  });

  it("offers 10 / 50 / 100 per page, resetting the page and keeping the filters", () => {
    const html = render({ page: 3, pageSize: 50, searchParams: { q: "rouge", status: "CONFIRMEE", page: "3", pageSize: "50" } });
    expect(html).toContain("Afficher");
    expect(html).toContain("par page");
    const sizeLinks = hrefs(html).filter((h) => !/[?&]page=/.test(h));
    expect(sizeLinks).toHaveLength(3);
    expect(sizeLinks).toContain("/commandes?q=rouge&status=CONFIRMEE");
    expect(sizeLinks).toContain("/commandes?q=rouge&status=CONFIRMEE&pageSize=50");
    expect(sizeLinks).toContain("/commandes?q=rouge&status=CONFIRMEE&pageSize=100");
    expect(html).toMatch(/aria-current="true"[^>]*>50</);
  });

  it("page links keep q/filters and the chosen size", () => {
    const html = render({ page: 2, pageSize: 50, total: 500 });
    const pageLinks = hrefs(html).filter((h) => /[?&]page=/.test(h));
    expect(pageLinks.length).toBeGreaterThan(0);
    for (const href of pageLinks) {
      const url = new URL(href, "http://x");
      expect(url.searchParams.get("q")).toBe("rouge");
      expect(url.searchParams.get("status")).toBe("CONFIRMEE");
      expect(url.searchParams.get("pageSize")).toBe("50");
    }
    expect(pageLinks).toContain("/commandes?q=rouge&status=CONFIRMEE&page=3&pageSize=50");
  });

  it("uses a per-table page param and size param", () => {
    const html = render({ page: 1, pageParam: "aexp", pageSizeParam: "aexpPageSize", basePath: "/livraison", searchParams: { page: "2" } });
    expect(hrefs(html)).toContain("/livraison?page=2&aexp=2");
    expect(hrefs(html)).toContain("/livraison?page=2&aexpPageSize=50");
  });

  it("without pageSizeOptions it renders no selector and the same links as before", () => {
    const html = render({ page: 1, pageSize: 20, pageSizeOptions: undefined, basePath: "/fournisseurs", searchParams: { q: "a" } });
    expect(html).not.toContain("par page");
    expect(hrefs(html)).toContain("/fournisseurs?q=a&page=2");
  });

  it("shows « Aucun résultat » for an empty list", () => {
    const html = render({ total: 0 });
    expect(html).toContain("Aucun résultat");
  });
});

describe("the five main list pages opt into 10 / 50 / 100", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
  const pages = [
    "src/app/(protected)/commandes/page.tsx",
    "src/app/(protected)/produits/page.tsx",
    "src/app/(protected)/livraison/page.tsx",
    "src/app/(protected)/livraison/suivi/page.tsx",
    "src/app/(protected)/stock/page.tsx",
  ];
  it.each(pages)("%s reads the size from the URL and offers PAGE_SIZE_OPTIONS", (rel) => {
    const src = read(rel);
    expect(src).toContain("pageSizeOptions={PAGE_SIZE_OPTIONS}");
    expect(src).toContain("parsePageSize(");
    expect(src).toContain("parsePage(");
    expect(src).toContain("redirect(");
  });
  it("/livraison paginates both tables with their own params", () => {
    const src = read("src/app/(protected)/livraison/page.tsx");
    expect(src.match(/pageSizeOptions=\{PAGE_SIZE_OPTIONS\}/g)).toHaveLength(2);
    expect(src).toContain('pageSizeParam="aexpPageSize"');
    expect(src).toContain('pageParam="aexp"');
  });
});
