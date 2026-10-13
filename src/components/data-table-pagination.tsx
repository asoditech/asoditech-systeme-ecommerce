import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildListHref, DEFAULT_PAGE_SIZE, lastPage, pageWindow } from "@/lib/pagination";

/**
 * URL-driven pagination — page/pageSize live in the query string, the page
 * itself does the counting/slicing server-side (Prisma skip/take). Never
 * paginate a dataset already fetched into the client.
 *
 * Numbered pages (« 1 … 4 5 6 … 20 », current one `aria-current="page"`)
 * inside a `<nav aria-label="Pagination">`. On a phone only Précédent, the
 * current page and Suivant stay visible. The page-size selector
 * (« Afficher 10 | 50 | 100 par page ») is opt-in via `pageSizeOptions`;
 * without it the links/params are exactly what they were before.
 */
export function DataTablePagination({
  page,
  pageSize,
  total,
  basePath,
  searchParams,
  pageParam = "page",
  hash,
  pageSizeOptions,
  pageSizeParam = "pageSize",
  defaultPageSize = DEFAULT_PAGE_SIZE,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  searchParams?: Record<string, string | undefined>;
  /** Query-string key for the page number. Override when two paginated
   * tables live on the same route (e.g. the Livraison tabs) so their page
   * cursors don't collide. */
  pageParam?: string;
  /** Optional `#fragment` appended to each link — keeps the browser on the
   * right tab/section after a page change. */
  hash?: string;
  /** Opt-in « Afficher N par page » selector (e.g. `[10, 50, 100]`). */
  pageSizeOptions?: readonly number[];
  /** Query-string key for the page size (one per table when two share a route). */
  pageSizeParam?: string;
  /** The size used when `pageSizeParam` is absent — left out of the links. */
  defaultPageSize?: number;
}) {
  const totalPages = lastPage(total, pageSize);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const sizeOptions = pageSizeOptions && pageSizeOptions.length > 0 ? pageSizeOptions : null;
  // With the selector on, the current size rides along on every page link
  // (dropped when it is the default, to keep URLs short).
  const sizeValue = sizeOptions && pageSize !== defaultPageSize ? pageSize : null;

  function hrefFor(targetPage: number) {
    const set: Record<string, string | number | null> = { [pageParam]: targetPage };
    if (sizeOptions) set[pageSizeParam] = sizeValue;
    return buildListHref(basePath, searchParams, set, hash);
  }

  /** A new size always restarts THIS table at page 1; every other param is kept. */
  function hrefForSize(size: number) {
    return buildListHref(
      basePath,
      searchParams,
      { [pageParam]: null, [pageSizeParam]: size === defaultPageSize ? null : size },
      hash
    );
  }

  const items = pageWindow(page, totalPages);

  return (
    <div className="flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-hairline px-4 py-3">
      <p className="text-sm text-ink-muted tabular-nums">
        {total === 0 ? "Aucun résultat" : `${from}–${to} sur ${total}`}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {sizeOptions && (
          <div className="flex h-9 items-center gap-2 text-sm text-ink-muted">
            <span>Afficher</span>
            <div role="group" aria-label="Lignes par page" className="inline-flex h-9 items-center gap-0.5 rounded-full bg-segment-track p-1">
              {sizeOptions.map((size) => {
                const active = size === pageSize;
                return (
                  <Link
                    key={size}
                    href={hrefForSize(size)}
                    aria-current={active ? "true" : undefined}
                    aria-label={`Afficher ${size} lignes par page`}
                    className={cn(
                      "inline-flex h-7 min-w-10 items-center justify-center rounded-full px-2.5 text-xs font-medium tabular-nums transition-[color,background-color,box-shadow] duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25",
                      active ? "bg-segment-thumb text-ink shadow-soft" : "text-ink-secondary hover:text-ink"
                    )}
                  >
                    {size}
                  </Link>
                );
              })}
            </div>
            <span>par page</span>
          </div>
        )}
        <nav aria-label="Pagination" className="flex h-9 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={page <= 1}
            aria-label="Page précédente"
            {...(page > 1 ? { render: <Link href={hrefFor(page - 1)} /> } : {})}
          >
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">Précédent</span>
          </Button>
          {items.map((item) =>
            typeof item === "number" ? (
              item === page ? (
                <span
                  key={item}
                  aria-current="page"
                  aria-label={`Page ${item} sur ${totalPages}`}
                  className="inline-flex h-9 min-w-9 items-center justify-center rounded-full bg-nav-active px-2.5 text-[13px] font-semibold text-ink tabular-nums shadow-soft"
                >
                  {item}
                </span>
              ) : (
                <Button
                  key={item}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Page ${item}`}
                  className="hidden w-auto min-w-9 px-2.5 tabular-nums sm:inline-flex"
                  render={<Link href={hrefFor(item)} />}
                >
                  {item}
                </Button>
              )
            ) : (
              <span
                key={item}
                aria-hidden="true"
                className="hidden h-9 min-w-6 items-center justify-center text-sm text-ink-faint sm:inline-flex"
              >
                …
              </span>
            )
          )}
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={page >= totalPages}
            aria-label="Page suivante"
            {...(page < totalPages ? { render: <Link href={hrefFor(page + 1)} /> } : {})}
          >
            <span className="hidden sm:inline">Suivant</span>
            <ChevronRight className="size-4" />
          </Button>
        </nav>
      </div>
    </div>
  );
}
