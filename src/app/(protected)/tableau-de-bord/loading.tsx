import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard loading state (Soft UI): the same bento shape as the page —
 * overview card + side list, two KPI tiles, the wide chart — in skeletons,
 * shown while the server gathers the figures. Purely visual, no data.
 */
export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Chargement du tableau de bord">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-full" />
      </div>

      <div className="mb-8 grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="space-y-6">
            <Skeleton className="h-6 w-48" />
            <div className="space-y-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-12 w-72 max-w-full" />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Skeleton className="h-[68px] rounded-tile" />
              <Skeleton className="h-[68px] rounded-tile" />
              <Skeleton className="h-[68px] rounded-tile" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent className="space-y-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-11 shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-1.5 w-full" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="mb-8 grid gap-5 sm:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <Card key={i}>
            <CardContent className="space-y-3">
              <Skeleton className="h-10 w-48" />
              <Skeleton className="h-10 w-56 max-w-full" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-64 max-w-full" />
        </CardHeader>
        <CardContent className="space-y-5">
          <Skeleton className="h-8 w-48" />
          <div className="flex h-[220px] items-end gap-3">
            {[40, 65, 30, 80, 55, 95, 45, 70, 35, 60, 50, 75].map((h, i) => (
              <Skeleton key={i} className="flex-1 rounded-lg" style={{ height: `${h}%` }} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
