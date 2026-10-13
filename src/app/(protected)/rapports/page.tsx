import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { MissingCostBanner } from "@/components/catalog-health/missing-cost-banner";
import { Card, CardContent } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/guards";
import { visibleReports } from "@/lib/navigation/reports";

export const metadata = { title: "Rapports — ASODITECH Gestion E-commerce" };

export default async function RapportsPage() {
  const user = await requirePermission("analytics.view");
  const REPORTS_VISIBLE = visibleReports(user);

  return (
    <div>
      <PageHeader
        title="Rapports"
        description="Rapports d'activité exportables (CSV et impression / PDF), avec filtres de période."
      />
      <MissingCostBanner user={user} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {REPORTS_VISIBLE.map((r) => {
          const Icon = r.icon;
          return (
            <Link key={r.href} href={r.href} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/40">
                <CardContent className="flex flex-col gap-2 pt-5">
                  <div className="flex size-10 items-center justify-center rounded-lg bg-primary/12 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <p className="font-medium">{r.title}</p>
                  <p className="text-sm text-muted-foreground">{r.description}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
