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
    <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3">
      <p className="text-sm text-muted-foreground tabular-nums">
        {total === 0 ? "Aucun résultat" : `${from}–${to} sur ${total}`}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {sizeOptions && (
          <div className="flex h-8 items-center gap-1.5 text-sm text-muted-foreground">
            <span>Afficher</span>
            <div role="group" aria-label="Lignes par page" className="inline-flex h-8 items-center rounded-lg border bg-card p-0.5">
              {sizeOptions.map((size) => {
                const active = size === pageSize;
                return (
                  <Link
                    key={size}
                    href={hrefForSize(size)}
                    aria-current={active ? "true" : undefined}
                    aria-label={`Afficher ${size} lignes par page`}
                    className={cn(
                      "inline-flex h-6.5 min-w-9 items-center justify-center rounded-md px-2 text-xs font-medium tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/35",
                      active
                        ? "bg-primary/10 text-accent-foreground ring-1 ring-primary/30 dark:text-primary"
                        : "text-foreground/80 hover:bg-accent hover:text-accent-foreground"
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
        <nav aria-label="Pagination" className="flex h-8 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
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
                  className="inline-flex h-8 min-w-8 items-center justify-center rounded-[calc(var(--radius)-1px)] border border-primary/45 bg-primary/10 px-2 text-[0.8rem] font-medium tabular-nums text-accent-foreground dark:text-primary"
                >
                  {item}
                </span>
              ) : (
                <Button
                  key={item}
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Page ${item}`}
                  className="hidden min-w-8 w-auto px-2 tabular-nums sm:inline-flex"
                  render={<Link href={hrefFor(item)} />}
                >
                  {item}
                </Button>
              )
            ) : (
              <span
                key={item}
                aria-hidden="true"
                className="hidden h-8 min-w-6 items-center justify-center text-sm text-muted-foreground sm:inline-flex"
              >
                …
              </span>
            )
          )}
          <Button
            variant="outline"
            size="sm"
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
