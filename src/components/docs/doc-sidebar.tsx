import Link from "next/link";
import { categoriesFor } from "@/lib/docs/categories";
import type { TenantCapability } from "@/lib/tenant/business-mode";
import { getArticlesByCategory, articleHref } from "@/lib/docs/registry";
import type { DocCategoryId } from "@/lib/docs/types";

/**
 * Left navigation for the Documentation Center — visually consistent with
 * the app's own sidebar (src/components/layout/sidebar-nav.tsx) but scoped
 * to /documentation and server-rendered (no permission filtering: every
 * article is readable by every logged-in user).
 */
export function DocSidebar({
  activeCategory,
  activeSlug,
  capabilities,
}: {
  activeCategory?: DocCategoryId;
  activeSlug?: string;
  /** The viewer's tenant capabilities (docs/adr/0041) — categories documenting a disabled capability are not listed. */
  capabilities: ReadonlySet<TenantCapability>;
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      {categoriesFor(capabilities).map((cat) => {
        const isActiveCategory = cat.id === activeCategory;
        const articles = isActiveCategory ? getArticlesByCategory(cat.id) : [];
        return (
          <div key={cat.id}>
            <Link
              href={`/documentation/${cat.id}`}
              className={`relative flex items-center gap-2 rounded-xl py-2 pr-2.5 pl-3.5 text-sm font-medium transition-colors ${
                isActiveCategory ? "bg-nav-active text-ink" : "text-ink-secondary hover:bg-nav-hover hover:text-ink"
              }`}
            >
                            <cat.icon className="size-4 shrink-0" />
              <span className="truncate">{cat.label}</span>
            </Link>
            {isActiveCategory && articles.length > 0 && (
              <ul className="mt-1 mb-2 ml-4 space-y-0.5 border-l border-hairline pl-3">
                {articles.map((a) => {
                  const tail = a.slug.slice(a.category.length + 1);
                  const isActive = tail === activeSlug;
                  return (
                    <li key={a.slug}>
                      <Link
                        href={articleHref(a)}
                        className={`block truncate rounded-lg px-2 py-1 text-[13px] ${
                          isActive ? "font-medium text-ink" : "text-ink-muted hover:text-ink"
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
