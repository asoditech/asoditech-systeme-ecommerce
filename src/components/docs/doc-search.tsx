"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Search, ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { searchArticles } from "@/lib/docs/search";
import { getCategory } from "@/lib/docs/categories";
import type { DocArticle } from "@/lib/docs/types";

function hrefFor(article: DocArticle): string {
  const tail = article.slug.slice(article.category.length + 1);
  return `/documentation/${article.category}/${tail}`;
}

/**
 * Instant in-browser search — no library, no network round-trip. `articles`
 * is the full static registry, passed down once from the server page.
 */
export function DocSearch({ articles, autoFocus }: { articles: DocArticle[]; autoFocus?: boolean }) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => (query.trim() ? searchArticles(articles, query) : []), [articles, query]);

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher un module, une action, un message d'erreur…"
          className="h-11 pl-9 text-[15px]"
        />
      </div>
      {query.trim() && (
        <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
          {results.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">Aucun résultat pour « {query} ».</p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto">
              {results.map((r) => (
                <li key={r.article.slug}>
                  <Link href={hrefFor(r.article)} className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-muted/50">
                    <div>
                      <p className="text-sm font-medium">{r.article.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {getCategory(r.article.category).label}
                        {r.matchedSymptom ? ` · ${r.matchedSymptom}` : ""}
                      </p>
                    </div>
                    <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function CategoryBadge({ category }: { category: DocArticle["category"] }) {
  return <Badge variant="secondary">{getCategory(category).label}</Badge>;
}
