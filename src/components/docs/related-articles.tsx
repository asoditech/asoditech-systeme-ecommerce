import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { articleHref } from "@/lib/docs/registry";
import type { DocArticle } from "@/lib/docs/types";

export function RelatedArticles({ articles }: { articles: DocArticle[] }) {
  if (articles.length === 0) return null;
  return (
    <div className="space-y-2">
      {articles.map((a) => (
        <Link key={a.slug} href={articleHref(a)} className="flex items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-sm hover:bg-muted/50">
          <span className="font-medium">{a.title}</span>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}
