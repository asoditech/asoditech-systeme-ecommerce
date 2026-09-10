import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StepsList } from "./steps-list";
import { BlockRenderer } from "./block-renderer";
import { TroubleshootingBlock } from "./troubleshooting-block";
import { RelatedArticles } from "./related-articles";
import { PrevNextNav } from "./prev-next-nav";
import { TryNowLink } from "./try-now-link";
import { getCategory } from "@/lib/docs/categories";
import { getRelatedArticles, getAdjacentArticles } from "@/lib/docs/registry";
import { formatDate } from "@/lib/format";
import type { DocArticle } from "@/lib/docs/types";
import type { UserRole } from "@prisma/client";

const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: "Propriétaire",
  ADMIN: "Administrateur",
  MANAGER: "Manager",
  CONFIRMATION: "Confirmation",
  WAREHOUSE: "Stock",
  DELIVERY: "Livraison",
  SUPPORT: "Support",
  ACCOUNTANT: "Comptable",
};

export function ArticleView({ article, viewerRole }: { article: DocArticle; viewerRole: UserRole }) {
  const category = getCategory(article.category);
  const related = getRelatedArticles(article);
  const { prev, next } = getAdjacentArticles(article);

  const toc: { id: string; label: string }[] = [];
  if (article.prerequisites?.length) toc.push({ id: "prerequisites", label: "Prérequis" });
  if (article.steps?.length) toc.push({ id: "steps", label: "Étapes" });
  if (article.whatYouShouldSee) toc.push({ id: "what-you-should-see", label: "Ce que vous devez voir" });
  if (article.commonMistakes?.length) toc.push({ id: "common-mistakes", label: "Erreurs fréquentes" });
  if (article.troubleshooting?.length) toc.push({ id: "troubleshooting", label: "Résolution des problèmes" });

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_200px]">
      <div className="min-w-0 space-y-6">
        <PageHeader
          title={article.title}
          description={article.tagline}
          breadcrumbs={[
            { label: "Documentation", href: "/documentation" },
            { label: category.label, href: `/documentation/${article.category}` },
            { label: article.title },
          ]}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {article.roles?.map((r) => (
            <Badge key={r} variant="outline">
              {ROLE_LABELS[r]}
            </Badge>
          ))}
          {article.permission && <Badge variant="secondary">{article.permission}</Badge>}
        </div>

        {article.prerequisites && article.prerequisites.length > 0 && (
          <Card id="prerequisites">
            <CardHeader>
              <CardTitle className="text-[15px]">Prérequis</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {article.prerequisites.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {article.steps && article.steps.length > 0 && (
          <Card id="steps">
            <CardHeader>
              <CardTitle className="text-[15px]">Étapes</CardTitle>
            </CardHeader>
            <CardContent>
              <StepsList steps={article.steps} />
            </CardContent>
          </Card>
        )}

        {article.whatYouShouldSee && (
          <Card id="what-you-should-see">
            <CardHeader>
              <CardTitle className="text-[15px]">Ce que vous devez voir</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-foreground/90">{article.whatYouShouldSee}</CardContent>
          </Card>
        )}

        {article.body && article.body.length > 0 && <BlockRenderer blocks={article.body} />}

        {article.commonMistakes && article.commonMistakes.length > 0 && (
          <Card id="common-mistakes">
            <CardHeader>
              <CardTitle className="text-[15px]">Erreurs fréquentes</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-1 pl-5 text-sm text-foreground/90">
                {article.commonMistakes.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {article.troubleshooting && article.troubleshooting.length > 0 && (
          <div id="troubleshooting">
            <h2 className="mb-2.5 text-[15px] font-semibold">Résolution des problèmes</h2>
            <TroubleshootingBlock entries={article.troubleshooting} />
          </div>
        )}

        <TryNowLink tryNow={article.tryNow} permission={article.permission} role={viewerRole} />

        {related.length > 0 && (
          <div>
            <h2 className="mb-2.5 text-[15px] font-semibold">Documentation liée</h2>
            <RelatedArticles articles={related} />
          </div>
        )}

        <p className="text-xs text-muted-foreground">Dernière mise à jour : {formatDate(article.lastUpdated)}</p>

        <PrevNextNav prev={prev} next={next} />
      </div>

      {toc.length > 0 && (
        <aside className="hidden lg:block">
          <div className="sticky top-6 space-y-1.5 rounded-lg border p-3">
            <p className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Sur cette page</p>
            {toc.map((t) => (
              <a key={t.id} href={`#${t.id}`} className="block rounded px-1.5 py-1 text-[13px] text-muted-foreground hover:text-foreground">
                {t.label}
              </a>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
