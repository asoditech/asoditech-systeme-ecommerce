import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getArticleBySlug, articleHref } from "@/lib/docs/registry";
import type { RolePath } from "@/lib/docs/types";

export function RoleStartCard({ path, highlighted }: { path: RolePath; highlighted?: boolean }) {
  const articles = path.slugs.map((s) => getArticleBySlug(s)).filter((a) => a !== undefined);
  return (
    <Card className={highlighted ? "border-primary/50 ring-1 ring-primary/20" : ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          {path.title}
          {highlighted && <Badge>Votre rôle</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2">
          {articles.map((a, i) => (
            <li key={a.slug}>
              <Link href={articleHref(a)} className="flex items-center gap-2 text-sm hover:underline">
                <span className="text-muted-foreground">{i + 1}.</span>
                {a.title}
                <ArrowRight className="ml-auto size-3.5 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
