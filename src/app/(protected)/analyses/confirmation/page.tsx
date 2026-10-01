import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { AnalyticsNav } from "@/components/analytics/analytics-nav";
import { AnalyticsFilterBar } from "@/components/analytics/analytics-filter-bar";
import { BreakdownBarList } from "@/components/analytics/breakdown-bar-list";
import { SeriesChart } from "@/components/analytics/series-chart";
import { SortHeader } from "@/components/analytics/sort-header";
import { MetricDefinitions } from "@/components/analytics/metric-definitions";
import { ShoppingCart, CheckCircle2, Percent, PhoneCall, Timer, Hourglass, Ban, UserX } from "lucide-react";
import { analyticsContext } from "@/lib/analytics/context";
import { analyticsQuery, SOURCE_KEYS, sortRows, sourceLabel } from "@/lib/analytics/filters";
import { formatHours, formatPct } from "@/lib/analytics/format";
import { getConfirmationAnalytics, getOnlineFilterOptions } from "@/lib/analytics/queries/online";
import { CONFIRMATION_OUTCOME_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Analyses — Confirmation — ASODITECH Gestion E-commerce" };

const OUTCOME_COLOR: Record<string, string> = {
  CONFIRME: "bg-emerald-500",
  ANNULE: "bg-rose-500",
  PAS_DE_REPONSE: "bg-amber-500",
  OCCUPE: "bg-amber-400",
  RAPPELER: "bg-cyan-500",
  FAUX_NUMERO: "bg-slate-400",
};

/**
 * Confirmation analytics (docs/adr/0051). The confirmer is the user who
 * RECORDED the attempt (`OrderConfirmationAttempt.agentUserId`) — never the
 * order creator, never the commission agent. A factual table, sortable,
 * without any score or ranking.
 */
export default async function ConfirmationAnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await analyticsContext(await searchParams, "confirmation");
  const { period, filters } = ctx;
  const [c, options] = await Promise.all([getConfirmationAnalytics(period, filters), getOnlineFilterOptions()]);

  const rows = sortRows(
    c.byConfirmer,
    filters,
    { name: (r) => r.name.toLowerCase(), attempts: (r) => r.attempts, confirmations: (r) => r.confirmations, cancellations: (r) => r.cancellations, time: (r) => r.avgConfirmationHours },
    "attempts"
  );
  const sortKey = filters.sort && ["name", "attempts", "confirmations", "cancellations", "time"].includes(filters.sort) ? filters.sort : "attempts";
  const dir = filters.dir ?? "desc";
  const head = (column: string, label: string, className?: string) => (
    <SortHeader column={column} label={label} basePath="/analyses/confirmation" params={ctx.params} active={sortKey === column} dir={dir} className={className} />
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Analyses — Confirmation" description={`File de confirmation des commandes en ligne — ${period.label}.`} />
      <AnalyticsNav access={ctx.access} active="confirmation" query={ctx.periodQuery} />
      <AnalyticsFilterBar
        basePath="/analyses/confirmation"
        period={period}
        filterParams={ctx.filterParams}
        exportHref={`/analyses/export/confirmation?${analyticsQuery(period, filters)}`}
        controls={[
          { paramKey: "source", value: filters.source, allLabel: "Toutes les origines", options: SOURCE_KEYS.map((k) => ({ value: k, label: sourceLabel(k) })) },
          { paramKey: "confirmateur", value: filters.confirmerId, allLabel: "Tous les confirmateurs", options: options.confirmers.map((u) => ({ value: u.id, label: u.name })) },
        ]}
      />

      {filters.confirmerId && (
        <p className="text-xs text-muted-foreground">
          Filtre confirmateur : s&apos;applique aux tentatives, au tableau et au délai de confirmation. Les entrées et le taux restent ceux de toute la file (une commande n&apos;appartient à aucun confirmateur avant d&apos;être appelée).
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Entrées dans la confirmation" value={String(c.entered)} icon={ShoppingCart} hint="Commandes passées sur la période" />
        <KpiCard label="Confirmées" value={String(c.confirmed)} icon={CheckCircle2} tone="success" hint={`${c.pending} encore à confirmer`} />
        <KpiCard label="Taux de confirmation" value={c.confirmationRate === null ? null : formatPct(c.confirmationRate)} unavailableReason="Aucune commande" icon={Percent} tone="info" />
        <KpiCard label="Annulées avant confirmation" value={String(c.cancelledBeforeConfirmation)} icon={Ban} tone="warning" />
        <KpiCard label="Tentatives d'appel" value={String(c.attempts)} icon={PhoneCall} tone="violet" hint={c.attemptsPerConfirmedOrder === null ? undefined : `${String(c.attemptsPerConfirmedOrder).replace(".", ",")} tentative(s) par confirmation`} />
        <KpiCard label="Délai moyen de confirmation" value={c.confirmationTime.sample ? formatHours(c.confirmationTime.avgHours) : null} unavailableReason="Aucune confirmation" icon={Timer} hint={c.confirmationTime.sample ? `sur ${c.confirmationTime.sample} commande(s)` : undefined} />
        <KpiCard label="Délai médian de confirmation" value={c.confirmationTime.sample ? formatHours(c.confirmationTime.medianHours) : null} unavailableReason="Aucune confirmation" icon={Hourglass} />
        <KpiCard label="Confirmées sans confirmateur enregistré" value={filters.confirmerId ? null : String(c.confirmedWithoutConfirmer)} unavailableReason="Sans objet (filtre confirmateur)" icon={UserX} tone="warning" hint="Importations / historique — attribuées à personne" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Entrées, confirmées et tentatives — {period.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <SeriesChart
              data={c.series}
              series={[
                { key: "entered", label: "Entrées (date de commande)", color: "var(--color-muted-foreground)" },
                { key: "confirmed", label: "Confirmées (même cohorte)", color: "var(--color-primary)" },
                { key: "attempts", label: "Tentatives (date de l'appel)", color: "#8b5cf6" },
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Résultats des tentatives</CardTitle>
          </CardHeader>
          <CardContent>
            {c.outcomes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune tentative sur la période.</p>
            ) : (
              <BreakdownBarList
                items={c.outcomes.map((o) => ({
                  key: o.outcome,
                  count: o.count,
                  label: <span className="text-sm font-medium">{CONFIRMATION_OUTCOME_LABELS[o.outcome] ?? o.outcome}</span>,
                  barColor: OUTCOME_COLOR[o.outcome] ?? "bg-muted-foreground",
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Par confirmateur</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune tentative sur la période.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {head("name", "Confirmateur")}
                  {head("attempts", "Tentatives", "text-right")}
                  {head("confirmations", "Confirmations", "text-right")}
                  {head("cancellations", "Annulations", "text-right")}
                  {head("time", "Délai moyen", "text-right")}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.userId ?? "none"}>
                    <TableCell className="font-medium">
                      {r.name}
                      {!r.active && r.userId && (
                        <Badge variant="outline" className="ml-2">
                          inactif
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.attempts}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.confirmations}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.cancellations}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatHours(r.avgConfirmationHours)}
                      {r.sample > 0 && <span className="ml-1 text-xs text-muted-foreground">({r.sample})</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Par origine</CardTitle>
        </CardHeader>
        <CardContent>
          {c.bySource.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune commande sur la période.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Origine</TableHead>
                  <TableHead className="text-right">Entrées</TableHead>
                  <TableHead className="text-right">Confirmées</TableHead>
                  <TableHead className="text-right">Taux</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.bySource.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell className="font-medium">{s.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.entered}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.confirmed}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatPct(s.rate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <MetricDefinitions section="confirmation" />
    </div>
  );
}
