import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * URL-driven pagination — page/pageSize live in the query string, the page
 * itself does the counting/slicing server-side (Prisma skip/take). Never
 * paginate a dataset already fetched into the client.
 */
export function DataTablePagination({
  page,
  pageSize,
  total,
  basePath,
  searchParams,
  pageParam = "page",
  hash,
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
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  function hrefFor(targetPage: number) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (value && key !== pageParam) params.set(key, value);
    }
    params.set(pageParam, String(targetPage));
    return `${basePath}?${params.toString()}${hash ?? ""}`;
  }

  return (
    <div className="flex items-center justify-between gap-4 border-t px-4 py-3">
      <p className="text-sm text-muted-foreground">
        {total === 0 ? "Aucun résultat" : `${from}–${to} sur ${total}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          {...(page > 1 ? { render: <Link href={hrefFor(page - 1)} /> } : {})}
        >
          <ChevronLeft className="size-4" />
          Précédent
        </Button>
        <span className="text-sm text-muted-foreground">
          Page {page} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          {...(page < totalPages ? { render: <Link href={hrefFor(page + 1)} /> } : {})}
        >
          Suivant
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
