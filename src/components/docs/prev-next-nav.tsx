import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { articleHref } from "@/lib/docs/registry";
import type { DocArticle } from "@/lib/docs/types";

export function PrevNextNav({ prev, next }: { prev: DocArticle | null; next: DocArticle | null }) {
  if (!prev && !next) return null;
  return (
    <div className="flex items-stretch justify-between gap-3 border-t pt-4">
      {prev ? (
        <Link href={articleHref(prev)} className="flex-1 rounded-lg border px-3.5 py-2.5 text-sm hover:bg-muted/50">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowLeft className="size-3.5" /> Précédent
          </span>
          <span className="mt-0.5 block font-medium">{prev.title}</span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
      {next ? (
        <Link href={articleHref(next)} className="flex-1 rounded-lg border px-3.5 py-2.5 text-right text-sm hover:bg-muted/50">
          <span className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
            Suivant <ArrowRight className="size-3.5" />
          </span>
          <span className="mt-0.5 block font-medium">{next.title}</span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}
