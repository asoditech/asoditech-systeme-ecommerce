import Link from "next/link";
import {
  ShoppingCart,
  Boxes,
  TriangleAlert,
  ArrowRight,
  Wallet,
  TrendingUp,
  Users,
  Truck,
  Receipt,
  ShoppingBag,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getDashboardData,
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard";
import { formatCurrency, formatDate, formatDateTime, formatOrderNumber } from "@/lib/format";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Tableau de bord — ASODITECH Gestion E-commerce" };

const PERIOD_SUFFIX: Record<DashboardPeriod, string> = {
  mois: "mois",
  trimestre: "trim.",
  annee: "année",
};

function trend(current: number, previous: number) {
  if (previous === 0) return undefined;
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return {
    direction: (change > 0.5 ? "up" : change < -0.5 ? "down" : "flat") as "up" | "down" | "flat",
    label: `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
  };
}

export default async function TableauDeBordPage({
  searchParams,
}: {
  searchParams: Promise<{ periode?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const periodKey: DashboardPeriod =
    params.periode === "trimestre" || params.periode === "annee" ? params.periode : "mois";
  const data = await getDashboardData(periodKey);
  const suffix = PERIOD_SUFFIX[periodKey];

  const canViewOrders = hasPermission(user.role, "orders.view");
  const canViewFinance = hasPermission(user.role, "finance.view");
  const canViewInventory = hasPermission(user.role, "inventory.view");
  const canViewDelivery = hasPermission(user.role, "delivery.view");
  const canViewCustomers = hasPermission(user.role, "customers.view");
  const canViewAudit = hasPermission(user.role, "audit.view");

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description={`Bonjour ${user.name.split(" ")[0]}, voici l'état de votre activité.`}
        actions={
          <div className="flex gap-1">
            {(Object.keys(DASHBOARD_PERIOD_LABELS) as DashboardPeriod[]).map((key) => (
              <Button
                key={key}
                size="sm"
                variant={key === periodKey ? "default" : "outline"}
                render={<Link href={key === "mois" ? "/tableau-de-bord" : `/tableau-de-bord?periode=${key}`} />}
              >
                {DASHBOARD_PERIOD_LABELS[key]}
              </Button>
            ))}
          </div>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {canViewFinance && (
          <>
            <KpiCard
              label={`Chiffre d'affaires (${suffix})`}
              value={formatCurrency(data.finance.revenue)}
              trend={trend(data.finance.revenue, data.previousFinance.revenue)}
              icon={Wallet}
              tone="primary"
            />
            <KpiCard
              label={`Charges (${suffix})`}
              value={formatCurrency(data.finance.chargesTotal)}
              hint="Dépenses enregistrées + coût de livraison"
              trend={trend(data.finance.chargesTotal, data.previousFinance.chargesTotal)}
              icon={Receipt}
              tone="warning"
            />
            <KpiCard
              label={`Bénéfice net (${suffix})`}
              value={data.finance.netProfit !== null ? formatCurrency(data.finance.netProfit) : null}
              unavailableReason="Non calculable"
              hint={!data.finance.cogsComplete ? "Coût d'achat manquant sur certains produits" : undefined}
              icon={TrendingUp}
              tone="success"
            />
            <KpiCard
              label={`Panier moyen (${suffix})`}
              value={data.finance.avgOrderValue !== null ? formatCurrency(data.finance.avgOrderValue) : null}
              unavailableReason="Aucune commande"
              icon={ShoppingBag}
              tone="info"
            />
          </>
        )}
        {canViewOrders && (
          <KpiCard label={`Commandes (${suffix})`} value={String(data.finance.ordersCount)} icon={ShoppingCart} tone="violet" />
        )}
        {canViewCustomers && (
          <KpiCard label={`Nouveaux clients (${suffix})`} value={String(data.newCustomersThisPeriod)} icon={Users} tone="info" />
        )}
        {canViewDelivery && (
          <KpiCard
            label="Taux de livraison réussie"
            value={data.deliveryStats.successRate !== null ? `${(data.deliveryStats.successRate * 100).toFixed(1)}%` : null}
            unavailableReason="Aucune expédition"
            icon={Truck}
            tone="warning"
          />
        )}
        {canViewInventory && (
          <KpiCard
            label="Produits en stock faible"
            value={String(data.lowStockCount)}
            hint={data.lowStockCount > 0 ? "Nécessite votre attention" : undefined}
            icon={Boxes}
            tone={data.lowStockCount > 0 ? "danger" : "primary"}
          />
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {canViewOrders && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Commandes nécessitant une action</CardTitle>
              <Button variant="ghost" size="sm" render={<Link href="/commandes" />}>
                Voir tout <ArrowRight className="size-4" />
              </Button>
            </CardHeader>
            <CardContent>
              {data.ordersRequiringAction.length === 0 ? (
                <EmptyState icon={ShoppingCart} title="Aucune commande en attente d'action." />
              ) : (
                <ul className="divide-y">
                  {data.ordersRequiringAction.map((o) => (
                    <li key={o.id} className="flex items-center justify-between py-2.5 text-sm">
                      <Link href={`/commandes/${o.id}`} className="hover:underline">
                        <span className="font-medium">{formatOrderNumber(o.orderNumber)}</span>{" "}
                        <span className="text-muted-foreground">— {o.customer.fullName}</span>
                      </Link>
                      <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {canViewDelivery && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Livraisons échouées</CardTitle>
              <Button variant="ghost" size="sm" render={<Link href="/livraison" />}>
                Voir tout <ArrowRight className="size-4" />
              </Button>
            </CardHeader>
            <CardContent>
              {data.failedShipments.length === 0 ? (
                <EmptyState icon={TriangleAlert} title="Aucune livraison échouée récemment." />
              ) : (
                <ul className="divide-y">
                  {data.failedShipments.map((s) => (
                    <li key={s.id} className="flex items-center justify-between py-2.5 text-sm">
                      <Link href={`/commandes/${s.orderId}`} className="hover:underline">
                        <span className="font-medium">{formatOrderNumber(s.order.orderNumber)}</span>{" "}
                        <span className="text-muted-foreground">— {s.order.customer.fullName}</span>
                      </Link>
                      <span className="text-xs text-muted-foreground">{formatDate(s.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {canViewOrders && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Commandes récentes</CardTitle>
              <Button variant="ghost" size="sm" render={<Link href="/commandes" />}>
                Voir tout <ArrowRight className="size-4" />
              </Button>
            </CardHeader>
            <CardContent>
              {data.recentOrders.length === 0 ? (
                <EmptyState icon={ShoppingCart} title="Aucune commande pour le moment." />
              ) : (
                <ul className="divide-y">
                  {data.recentOrders.map((o) => (
                    <li key={o.id} className="flex items-center justify-between py-2.5 text-sm">
                      <Link href={`/commandes/${o.id}`} className="hover:underline">
                        <span className="font-medium">{formatOrderNumber(o.orderNumber)}</span>{" "}
                        <span className="text-muted-foreground">— {o.customer.fullName}</span>
                      </Link>
                      <span>{formatCurrency(o.total.toString(), o.currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}

        {canViewAudit && (
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Activité récente</CardTitle>
              <Button variant="ghost" size="sm" render={<Link href="/journal-audit" />}>
                Voir tout <ArrowRight className="size-4" />
              </Button>
            </CardHeader>
            <CardContent>
              {data.recentAuditEvents.length === 0 ? (
                <EmptyState icon={Boxes} title="Aucune activité enregistrée." />
              ) : (
                <ul className="divide-y">
                  {data.recentAuditEvents.map((e) => (
                    <li key={e.id} className="py-2.5 text-sm">
                      <p>
                        <span className="font-medium">{e.actorUser?.name ?? "Système"}</span>{" "}
                        <span className="text-muted-foreground">— {e.action}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
