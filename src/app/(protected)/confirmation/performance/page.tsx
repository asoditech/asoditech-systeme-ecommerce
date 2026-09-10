import Link from "next/link";
import { PhoneCall, CheckCircle2, RotateCcw, Percent, HandCoins, Users } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { Badge } from "@/components/ui/badge";
import { DateRangeFilter } from "@/components/date-range-filter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { listAgentPerformance } from "@/lib/queries/commissions";
import { resolveDateRangePreset, DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";
import { formatCurrency, formatPercent } from "@/lib/format";

export const metadata = { title: "Performance confirmation — ASODITECH Gestion E-commerce" };

/**
 * Read-only cross-agent view over docs/adr/0022 (commission) and
 * docs/adr/0029 (confirmation) data. It never writes: no CommissionEntry,
 * no confirmationAgentId change, no statement close/payment, no order
 * status change. See `listAgentPerformance` for the metric definitions.
 */
export default async function ConfirmationPerformancePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; dateFrom?: string; dateTo?: string }>;
}) {
  await requirePermission("commissions.view");
  const params = await searchParams;

  // Defaults to "this-month" (not /livraison's "all") — a managerial
  // performance view is more useful scoped to recent activity by default.
  const rangeParam: DateRangePreset =
    params.range && params.range in DATE_RANGE_PRESET_LABELS ? (params.range as DateRangePreset) : "this-month";
  const preset: DateRangePreset = params.dateFrom || params.dateTo ? "custom" : rangeParam;
  const { from, to } = resolveDateRangePreset(preset, new Date(), { from: params.dateFrom, to: params.dateTo });

  const rows = await listAgentPerformance(from || to ? { from, to } : undefined);
  const currency = rows[0]?.currency ?? "MAD";
  const sorted = [...rows].sort((a, b) => b.confirmedTotal - a.confirmedTotal);

  const totals = rows.reduce(
    (acc, r) => ({
      confirmed: acc.confirmed + r.confirmedTotal,
      delivered: acc.delivered + r.pipeline.delivered,
      returned: acc.returned + r.pipeline.returned,
      earned: acc.earned + r.breakdown.earnedAmount,
      reversed: acc.reversed + r.breakdown.reversedAmount,
    }),
    { confirmed: 0, delivered: 0, returned: 0, earned: 0, reversed: 0 }
  );
  const overallConversion = totals.confirmed > 0 ? totals.delivered / totals.confirmed : null;
  const hasAnyConfirmation = totals.confirmed > 0;

  return (
    <div>
      <PageHeader
        title="Performance confirmation"
        description="Suivi des confirmations, livraisons, retours et commissions par agent."
        breadcrumbs={[{ label: "Confirmation", href: "/confirmation" }, { label: "Performance" }]}
        actions={
          <DateRangeFilter
            basePath="/confirmation/performance"
            initialRange={preset}
            initialFrom={params.dateFrom}
            initialTo={params.dateTo}
            defaultRange="this-month"
          />
        }
      />

      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Confirmées" value={String(totals.confirmed)} icon={PhoneCall} tone="primary" />
        <KpiCard label="Livrées" value={String(totals.delivered)} icon={CheckCircle2} tone="success" />
        <KpiCard
          label="Taux confirmation → livraison"
          value={overallConversion !== null ? formatPercent(overallConversion, 0) : null}
          unavailableReason="Aucune confirmation sur cette période"
          icon={Percent}
          tone="info"
        />
        <KpiCard label="Retours" value={String(totals.returned)} icon={RotateCcw} tone="warning" />
        <KpiCard label="Commission acquise" value={formatCurrency(totals.earned, currency)} icon={HandCoins} tone="success" />
        <KpiCard
          label="Commission reversée"
          value={formatCurrency(Math.abs(totals.reversed), currency)}
          icon={HandCoins}
          tone="danger"
        />
      </div>

      <div className="mb-4 space-y-1 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p>
          Le taux Confirmation → Livraison correspond au nombre de commandes confirmées par l&apos;agent ayant été
          livrées, rapporté au nombre de commandes confirmées par cet agent.
        </p>
        <p>
          Une confirmation ne constitue pas une commission acquise. La commission est acquise uniquement lorsque la
          commande est livrée, selon les règles de commission existantes.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Users} title="Aucun agent de confirmation trouvé." />
      ) : !hasAnyConfirmation ? (
        <EmptyState icon={PhoneCall} title="Aucune confirmation sur cette période." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Confirmées</TableHead>
                <TableHead className="text-right">Livrées</TableHead>
                <TableHead>Conversion</TableHead>
                <TableHead className="text-right">Retours</TableHead>
                <TableHead className="text-right">Acquise</TableHead>
                <TableHead className="text-right">Reversée</TableHead>
                <TableHead className="text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/commissions/${r.id}`} className="font-medium hover:underline">
                      {r.userName}
                    </Link>
                    {!r.isActive && (
                      <Badge variant="secondary" className="ml-2">
                        Inactif
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.confirmedTotal}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.pipeline.delivered}</TableCell>
                  <TableCell>
                    {r.conversion === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums">{formatPercent(r.conversion, 0)}</span>
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <span
                            className="block h-full bg-primary"
                            style={{ width: `${Math.round(r.conversion * 100)}%` }}
                          />
                        </span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.pipeline.returned}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.breakdown.earnedAmount, r.currency)}</TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">
                    {r.breakdown.reversedCount > 0 ? formatCurrency(Math.abs(r.breakdown.reversedAmount), r.currency) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrency(r.breakdown.netAmount, r.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
