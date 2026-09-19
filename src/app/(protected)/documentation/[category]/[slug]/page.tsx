import { notFound } from "next/navigation";
import { DocSidebar } from "@/components/docs/doc-sidebar";
import { ArticleView } from "@/components/docs/article-view";
import { requireUser } from "@/lib/auth/guards";
import { getArticleBySlug, ALL_ARTICLES } from "@/lib/docs/registry";
import { DOC_CATEGORIES, isCategoryAvailable } from "@/lib/docs/categories";
import type { DocCategoryId } from "@/lib/docs/types";

export async function generateStaticParams() {
  return ALL_ARTICLES.map((a) => ({
    category: a.category,
    slug: a.slug.slice(a.category.length + 1),
  }));
}

export default async function DocArticlePage({ params }: { params: Promise<{ category: string; slug: string }> }) {
  const user = await requireUser();
  const { category, slug } = await params;
  if (!DOC_CATEGORIES.some((c) => c.id === category)) notFound();
  if (!isCategoryAvailable(category as DocCategoryId, user.capabilities)) notFound(); // docs/adr/0041

  const article = getArticleBySlug(`${category}/${slug}`);
  if (!article) notFound();

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
      <aside className="hidden lg:block">
        <DocSidebar activeCategory={category as DocCategoryId} activeSlug={slug} capabilities={user.capabilities} />
      </aside>
      <ArticleView article={article} viewer={user} />
    </div>
  );
}
