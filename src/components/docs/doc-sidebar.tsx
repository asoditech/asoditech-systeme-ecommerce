import Link from "next/link";
import { DOC_CATEGORIES } from "@/lib/docs/categories";
import { getArticlesByCategory, articleHref } from "@/lib/docs/registry";
import type { DocCategoryId } from "@/lib/docs/types";

/**
 * Left navigation for the Documentation Center — visually consistent with
 * the app's own sidebar (src/components/layout/sidebar-nav.tsx) but scoped
 * to /documentation and server-rendered (no permission filtering: every
 * article is readable by every logged-in user).
 */
export function DocSidebar({ activeCategory, activeSlug }: { activeCategory?: DocCategoryId; activeSlug?: string }) {
  return (
    <nav className="flex flex-col gap-4">
      {DOC_CATEGORIES.map((cat) => {
        const isActiveCategory = cat.id === activeCategory;
        const articles = isActiveCategory ? getArticlesByCategory(cat.id) : [];
        return (
          <div key={cat.id}>
            <Link
              href={`/documentation/${cat.id}`}
              className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium ${
                isActiveCategory ? "bg-primary/10 text-primary" : "text-foreground/80 hover:bg-muted"
              }`}
            >
              <cat.icon className="size-4 shrink-0" />
              {cat.label}
            </Link>
            {isActiveCategory && articles.length > 0 && (
              <ul className="mt-1 ml-4 space-y-0.5 border-l pl-3">
                {articles.map((a) => {
                  const tail = a.slug.slice(a.category.length + 1);
                  const isActive = tail === activeSlug;
                  return (
                    <li key={a.slug}>
                      <Link
                        href={articleHref(a)}
                        className={`block truncate rounded-md px-2 py-1 text-[13px] ${
                          isActive ? "font-medium text-primary" : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {a.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
