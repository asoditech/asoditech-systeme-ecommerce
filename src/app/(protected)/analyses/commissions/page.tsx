import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AnalyticsNav } from "@/components/analytics/analytics-nav";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { SeriesChart } from "@/components/analytics/series-chart";
import { SortHeader } from "@/components/analytics/sort-header";
import { MetricDefinitions } from "@/components/analytics/metric-definitions";
import { HandCoins, Undo2, Wallet } from "lucide-react";
import { analyticsContext } from "@/lib/analytics/context";
import { analyticsQuery, SOURCE_KEYS, sortRows, sourceLabel } from "@/lib/analytics/filters";
import { getCommissionAnalytics, listCommissionAgentOptions, type AgentCommissionRow } from "@/lib/analytics/queries/commissions";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Analyses — Commissions — ASODITECH Gestion E-commerce" };

const COLUMNS = {
  name: (r: AgentCommissionRow) => r.name.toLowerCase(),
  earned: (r: AgentCommissionRow) => r.earned,
  reversed: (r: AgentCommissionRow) => r.reversed,
  net: (r: AgentCommissionRow) => r.net,
};

/**
 * Commission analytics (docs/adr/0051) — a read-only view of the existing
 * ledger: amounts are the entries' own snapshot amounts, dated by the entry.
 * Requires `commissions.view` (same as /commissions).
 */
export default async function CommissionAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await analyticsContext(await searchParams, "commissions");
  const { period, filters } = ctx;
  const [c, agents] = await Promise.all([getCommissionAnalytics(period, filters), listCommissionAgentOptions()]);
  const rows = sortRows(c.byAgent, filters, COLUMNS, "net");
  const sortKey = filters.sort && filters.sort in COLUMNS ? filters.sort : "net";
  const dir = filters.dir ?? "desc";
  const head = (column: string, label: string, className?: string) => (
    <SortHeader column={column} label={label} basePath="/analyses/commissions" params={ctx.params} active={sortKey === column} dir={dir} className={className} />
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses — Commissions" description={`Registre des commissions de confirmation — écritures datées de la période (${period.label}).`} />
      <AnalyticsNav access={ctx.access} active="commissions" query={ctx.periodQuery} />
      <AnalyticsFilterBar
        basePath="/analyses/commissions"
        period={period}
        filterParams={ctx.filterParams}
        exportHref={`/analyses/export/commissions?${analyticsQuery(period, filters)}`}
        controls={[
          { paramKey: "agent", value: filters.agentId, allLabel: "Tous les agents", options: agents.map((a) => ({ value: a.id, label: a.name })) },
          { paramKey: "source", value: filters.source, allLabel: "Toutes les origines", options: SOURCE_KEYS.map((k) => ({ value: k, label: sourceLabel(k) })) },
        ]}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard label="Commissions gagnées" value={formatCurrency(c.earned)} icon={HandCoins} tone="success" hint={`${c.earnedCount} écriture(s) — commandes passées à Livrée`} />
        <KpiCard label="Commissions annulées" value={formatCurrency(c.reversed)} icon={Undo2} tone="danger" hint={`${c.reversedCount} écriture(s) — commandes sorties de Livrée`} />
        <KpiCard label="Commissions nettes" value={formatCurrency(c.net)} icon={Wallet} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Par période</CardTitle>
        </CardHeader>
        <CardContent>
          <SeriesChart
            data={c.series}
            currency
            series={[
              { key: "earned", label: "Gagnées", color: "#10b981" },
              { key: "reversed", label: "Annulées", color: "#f43f5e" },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Par agent</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune écriture de commission sur la période.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {head("name", "Agent")}
                  {head("earned", "Gagnées", "text-right")}
                  {head("reversed", "Annulées", "text-right")}
                  {head("net", "Nettes", "text-right")}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.agentId}>
                    <TableCell className="font-medium">
                      {r.name}
                      {!r.active && (
                        <Badge variant="outline" className="ml-2">
                          inactif
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.earned)} <span className="text-xs text-muted-foreground">({r.earnedCount})</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(r.reversed)} <span className="text-xs text-muted-foreground">({r.reversedCount})</span>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatCurrency(r.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <MetricDefinitions section="commissions" />
    </div>
  );
}
