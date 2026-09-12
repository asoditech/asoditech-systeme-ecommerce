import { Building2, CheckCircle2, PauseCircle, AlertTriangle, XCircle, Gauge } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { CreateTenantForm } from "@/components/platform/create-tenant-form";
import { TenantRowControls } from "@/components/platform/tenant-row-controls";
import { TenantPlanDialog } from "@/components/platform/tenant-plan-dialog";
import { DeleteTenantButton } from "@/components/platform/delete-tenant-button";
import { KpiCard } from "@/components/kpi-card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listTenantsWithUsage, summarizePlatformOverview } from "@/lib/queries/platform";
import { formatDateTime, formatNumber } from "@/lib/format";
import { PLAN_CODE_LABELS, SUBSCRIPTION_STATUS_LABELS, USAGE_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Plateforme — ASODITECH Gestion E-commerce" };

/**
 * `/platform` — tenant list + overview (docs/adr/0035 "Platform
 * monitoring"). `listTenantsWithUsage` does a small, fixed number of
 * aggregate queries regardless of tenant count (never one query per
 * tenant — see that function's own doc comment), so this page stays fast
 * at 10, 50, 100, or 500 tenants.
 */
export default async function PlatformPage() {
  const rows = await listTenantsWithUsage();
  const overview = summarizePlatformOverview(rows);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenants"
        description="Espaces de travail provisionnés sur ce déploiement."
        actions={<CreateTenantForm />}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard label="Tenants actifs" value={formatNumber(overview.activeTenants)} icon={Building2} hint={`sur ${overview.totalTenants}`} tone="primary" />
        <KpiCard label="Business" value={formatNumber(overview.businessTenants)} icon={CheckCircle2} tone="info" />
        <KpiCard label="Pro" value={formatNumber(overview.proTenants)} icon={CheckCircle2} tone="violet" />
        <KpiCard label="Suspendus" value={formatNumber(overview.suspendedTenants)} icon={PauseCircle} tone="danger" />
        <KpiCard label="Paiement en retard" value={formatNumber(overview.pastDueSubscriptions)} icon={AlertTriangle} tone="warning" />
        <KpiCard label="Résiliés" value={formatNumber(overview.canceledSubscriptions)} icon={XCircle} tone="danger" />
        <KpiCard label="Proche de la limite" value={formatNumber(overview.nearLimitTenants)} icon={Gauge} tone="warning" />
        <KpiCard label="Limite atteinte" value={formatNumber(overview.overLimitTenants)} icon={Gauge} tone="danger" />
      </div>

      <div className="overflow-x-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tenant</TableHead>
              <TableHead>Forfait</TableHead>
              <TableHead>Commandes</TableHead>
              <TableHead>Utilisateurs</TableHead>
              <TableHead>Entrepôts</TableHead>
              <TableHead>Abonnement</TableHead>
              <TableHead>Utilisation</TableHead>
              <TableHead>Dernière activité</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  {row.name}
                  <div className="text-xs font-normal text-muted-foreground">{row.slug}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={row.planCode === "PRO" ? "default" : "secondary"}>{PLAN_CODE_LABELS[row.planCode] ?? row.planCode}</Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {formatNumber(row.orders.used)}
                  {row.orders.limit !== null && <span className="text-muted-foreground"> / {formatNumber(row.orders.limit)}</span>}
                </TableCell>
                <TableCell className="text-sm">
                  {formatNumber(row.users.used)}
                  {row.users.limit !== null && <span className="text-muted-foreground"> / {formatNumber(row.users.limit)}</span>}
                </TableCell>
                <TableCell className="text-sm">
                  {formatNumber(row.warehouses.used)}
                  {row.warehouses.limit !== null && <span className="text-muted-foreground"> / {formatNumber(row.warehouses.limit)}</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={SUBSCRIPTION_STATUS_LABELS[row.subscriptionStatus]?.variant ?? "secondary"}>
                    {SUBSCRIPTION_STATUS_LABELS[row.subscriptionStatus]?.label ?? row.subscriptionStatus}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={USAGE_STATUS_LABELS[row.overallStatus]?.variant ?? "secondary"}>
                    {USAGE_STATUS_LABELS[row.overallStatus]?.label ?? row.overallStatus}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {row.lastActivityAt ? formatDateTime(row.lastActivityAt) : "—"}
                </TableCell>
                <TableCell>
                  <TenantRowControls tenantId={row.id} status={row.tenantStatus} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TenantPlanDialog tenantId={row.id} currentPlanCode={row.planCode} currentStatus={row.subscriptionStatus} />
                    <DeleteTenantButton tenantId={row.id} tenantSlug={row.slug} tenantName={row.name} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
