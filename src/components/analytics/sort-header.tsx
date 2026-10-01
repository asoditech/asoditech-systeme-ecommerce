import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** A factual-table column header that sorts server-side via `?sort=&dir=` (no ranking, no score). */
export function SortHeader({
  column,
  label,
  basePath,
  params,
  active,
  dir,
  className,
}: {
  column: string;
  label: string;
  basePath: string;
  params: Record<string, string>;
  active: boolean;
  dir: "asc" | "desc";
  className?: string;
}) {
  const sp = new URLSearchParams(params);
  sp.set("sort", column);
  sp.set("dir", active && dir === "desc" ? "asc" : "desc");
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      <Link href={`${basePath}?${sp.toString()}`} className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}>
        {label}
        {active && <Icon className="size-3" />}
      </Link>
    </TableHead>
  );
}
