/**
 * Pure helpers for URL-driven, server-side list pagination (page / pageSize
 * live in the query string; the page does `skip`/`take` in Prisma). Shared by
 * `DataTablePagination` and the list pages that opt into the page-size
 * selector — no React, no Prisma, no server-only imports, so they are unit-
 * testable on their own (tests/lib/pagination.test.ts).
 */

/** The page sizes a list page may offer (« Afficher 10 | 50 | 100 par page »). */
export const PAGE_SIZE_OPTIONS = [10, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 10;

type RawParam = string | string[] | undefined | null;

function first(raw: RawParam): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw ?? undefined;
}

/** A 1-based page number from the URL: any positive integer, else 1. */
export function parsePage(raw: RawParam): number {
  const value = first(raw);
  if (!value || !/^\d+$/.test(value.trim())) return 1;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/**
 * The page size from the URL — only one of the allowed `options` is accepted
 * (never an arbitrary `?pageSize=100000`); anything else falls back to the
 * default.
 */
export function parsePageSize(
  raw: RawParam,
  options: readonly number[] = PAGE_SIZE_OPTIONS,
  fallback: number = DEFAULT_PAGE_SIZE
): number {
  const value = first(raw);
  if (!value || !/^\d+$/.test(value.trim())) return fallback;
  const n = Number(value.trim());
  return options.includes(n) ? n : fallback;
}

/** Number of pages for `total` rows (always ≥ 1, so an empty list is « page 1 / 1 »). */
export function lastPage(total: number, pageSize: number): number {
  if (!(pageSize > 0) || !(total > 0)) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** `page` kept inside [1, lastPage]. */
export function clampPage(page: number, total: number, pageSize: number): number {
  const p = Number.isFinite(page) ? Math.floor(page) : 1;
  return Math.min(Math.max(1, p), lastPage(total, pageSize));
}

export type PageWindowItem = number | "ellipsis-start" | "ellipsis-end";

/**
 * The numbered buttons to show: first, last, and `siblings` pages either side
 * of the current one, with an ellipsis for any gap of 2+ pages (a gap of
 * exactly one page shows that page instead — « 1 … 3 » would be silly).
 *   pageWindow(5, 20) → [1, "ellipsis-start", 4, 5, 6, "ellipsis-end", 20]
 */
export function pageWindow(current: number, totalPages: number, siblings = 1): PageWindowItem[] {
  const total = Math.max(1, Math.floor(totalPages));
  const page = Math.min(Math.max(1, Math.floor(current)), total);
  const start = Math.max(2, page - siblings);
  const end = Math.min(total - 1, page + siblings);
  const items: PageWindowItem[] = [1];
  if (start > 3) items.push("ellipsis-start");
  else for (let p = 2; p < start; p++) items.push(p);
  for (let p = start; p <= end; p++) items.push(p);
  if (end < total - 2) items.push("ellipsis-end");
  else for (let p = end + 1; p < total; p++) items.push(p);
  if (total > 1) items.push(total);
  return items;
}

export type SearchParamsInput = Record<string, RawParam>;

/**
 * `basePath?…` keeping every current query param, with `set` applied on top
 * (a `null`/`undefined`/"" value removes that key). Used for page links,
 * page-size links and the out-of-range redirect, so filters, search, sort and
 * another table's cursor always survive.
 */
export function buildListHref(
  basePath: string,
  searchParams: SearchParamsInput | undefined,
  set: Record<string, string | number | null | undefined> = {},
  hash?: string
): string {
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(searchParams ?? {})) {
    if (key in set) continue;
    const value = first(raw);
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(set)) {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return `${basePath}${qs ? `?${qs}` : ""}${hash ?? ""}`;
}

/**
 * Where to send the browser when `page` is past the last page of a non-empty
 * result (e.g. the last row of the last page was just deleted) — the last
 * page, every other param preserved. `null` when the page is fine (or the
 * list is empty: « Aucun résultat » on page 1 needs no redirect).
 */
export function outOfRangeHref(opts: {
  page: number;
  total: number;
  pageSize: number;
  basePath: string;
  searchParams: SearchParamsInput | undefined;
  pageParam?: string;
}): string | null {
  const { page, total, pageSize, basePath, searchParams, pageParam = "page" } = opts;
  if (total <= 0) return null;
  const last = lastPage(total, pageSize);
  if (page <= last) return null;
  return buildListHref(basePath, searchParams, { [pageParam]: last });
}
