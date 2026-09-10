import Link from "next/link";
import { ArrowRight, Compass } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocSearch } from "@/components/docs/doc-search";
import { RoleStartCard } from "@/components/docs/role-start-card";
import { requireUser } from "@/lib/auth/guards";
import { ALL_ARTICLES } from "@/lib/docs/registry";
import { DOC_CATEGORIES } from "@/lib/docs/categories";
import { ROLE_PATHS, getRolePath } from "@/lib/docs/role-paths";
import { GUIDED_TOURS } from "@/lib/docs/guided-tours";

export const metadata = { title: "Documentation — ASODITECH Gestion E-commerce" };

export default async function DocumentationHomePage() {
  const user = await requireUser();
  const myPath = getRolePath(user.role);
  const otherPaths = ROLE_PATHS.filter((p) => p.role !== user.role);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Centre de documentation"
        description="Comprenez ASODITECH de zéro à l'usage avancé — chaque module, chaque action, chaque erreur et sa solution."
      />

      <DocSearch articles={ALL_ARTICLES} autoFocus />

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Compass className="size-4 text-primary" />
          <h2 className="text-[15px] font-semibold">Vous êtes nouveau sur ASODITECH ? Commencez ici.</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {myPath && <RoleStartCard path={myPath} highlighted />}
          {otherPaths.map((p) => (
            <RoleStartCard key={p.role} path={p} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold">Toutes les catégories</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DOC_CATEGORIES.map((cat) => (
            <Link key={cat.id} href={`/documentation/${cat.id}`}>
              <Card className="h-full transition-colors hover:border-primary/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-[15px]">
                    <cat.icon className="size-4 text-muted-foreground" />
                    {cat.label}
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">{cat.description}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[15px] font-semibold">Démos guidées</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GUIDED_TOURS.map((tour) => (
            <Link
              key={tour.slug}
              href={`/documentation/demos/${tour.slug}`}
              className="flex items-center justify-between gap-2 rounded-lg border p-3.5 text-sm hover:bg-muted/50"
            >
              <div>
                <p className="font-medium">{tour.title}</p>
                <p className="text-xs text-muted-foreground">{tour.tagline}</p>
              </div>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
