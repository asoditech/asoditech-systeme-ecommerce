import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { DocSidebar } from "@/components/docs/doc-sidebar";
import { requireUser } from "@/lib/auth/guards";
import { DOC_CATEGORIES, getCategory } from "@/lib/docs/categories";
import { getArticlesByCategory, articleHref } from "@/lib/docs/registry";
import type { DocCategoryId } from "@/lib/docs/types";

export async function generateStaticParams() {
  return DOC_CATEGORIES.map((c) => ({ category: c.id }));
}

export default async function DocCategoryPage({ params }: { params: Promise<{ category: string }> }) {
  await requireUser();
  const { category } = await params;
  if (!DOC_CATEGORIES.some((c) => c.id === category)) notFound();
  const cat = getCategory(category as DocCategoryId);
  const articles = getArticlesByCategory(cat.id);

  return (
    <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
      <aside className="hidden lg:block">
        <DocSidebar activeCategory={cat.id} />
      </aside>
      <div className="min-w-0">
        <PageHeader
          title={cat.label}
          description={cat.description}
          breadcrumbs={[{ label: "Documentation", href: "/documentation" }, { label: cat.label }]}
        />
        <div className="space-y-2">
          {articles.map((a) => (
            <Link key={a.slug} href={articleHref(a)} className="flex items-center justify-between gap-3 rounded-lg border p-3.5 hover:bg-muted/50">
              <div>
                <p className="text-sm font-medium">{a.title}</p>
                <p className="text-xs text-muted-foreground">{a.tagline}</p>
              </div>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
