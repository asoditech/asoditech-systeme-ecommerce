import { notFound } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { MetricBreakdown } from "@/components/metric-breakdown";
import { MetricWithProgress } from "@/components/metric-with-progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { getAgentCommissionDetail } from "@/lib/queries/commissions";
import { closeCommissionStatementAction, markCommissionStatementPaidAction } from "@/actions/commissions";
import { formatCurrency, formatDate, formatDateTime, displayOrderNumber } from "@/lib/format";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { ORDER_STATUS_LABELS } from "@/lib/status-labels";
import { AgentRateForm } from "@/components/commissions/agent-rate-form";
import { FileText, Clock, Scale, PhoneCall, CheckCircle2, RotateCcw, HandCoins } from "lucide-react";

export const metadata = { title: "Agent — Commissions — ASODITECH" };

const STATEMENT_STATUS_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" }> = {
  CLOTURE: { label: "Clôturé", variant: "secondary" },
  PAYE: { label: "Payé", variant: "success" },
};

const MONTH_NAMES = ["", "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

export default async function CommissionAgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const user = await requirePermission("commissions.view");
  const canManage = userHasPermission(user, "commissions.manage");
  const { agentId } = await params;
  const [detail, business] = await Promise.all([getAgentCommissionDetail(agentId), getReportBusinessInfo()]);
  if (!detail) notFound();

  const { agent, totals, pipeline, breakdown, statements, openMonths, openEntries } = detail;
  const now = new Date();
  const currentPeriod = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };

  // Same "Confirmées" definition as /confirmation/performance: every order
  // that reached CONFIRMEE at least once, i.e. every pipeline bucket except
  // "pending" (NOUVELLE — never actually confirmed).
  const confirmedTotal = pipeline.total - pipeline.pending;
  const conversion = confirmedTotal > 0 ? pipeline.delivered / confirmedTotal : null;

  return (
    <div>
      <PageHeader
        title={agent.userName}
        breadcrumbs={[{ label: "Commissions", href: "/commissions" }, { label: agent.userName }]}
        description={`Taux actuel : ${formatCurrency(String(agent.ratePerOrder), agent.currency)} par commande livrée.`}
        actions={
          <Link href={`/commandes?confirmationAgent=${agent.id}`} className="text-sm text-primary hover:underline">
            Voir les commandes confirmées →
          </Link>
        }
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-[15px]">Performance confirmation</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <MetricBreakdown
            className="px-6"
            rows={[
              { key: "confirmed", label: "Confirmées", value: String(confirmedTotal), icon: PhoneCall, tone: "default" },
              {
                key: "delivered",
                label: "Livrées",
                value: String(pipeline.delivered),
                meta: `En cours : ${pipeline.confirmed}`,
                icon: CheckCircle2,
                tone: "success",
              },
              {
                key: "conversion",
                label: "Taux de conversion",
                value: conversion !== null ? `${Math.round(conversion * 100)}%` : "—",
                icon: Scale,
                tone: "default",
              },
              {
                key: "returned",
                label: "Retournées",
                value: String(pipeline.returned),
                icon: RotateCcw,
                tone: pipeline.returned > 0 ? "danger" : "default",
              },
              {
                key: "earned",
                label: "Commission acquise",
                value: formatCurrency(String(breakdown.earnedAmount), agent.currency),
                icon: HandCoins,
                tone: "success",
              },
              {
                key: "reversed",
                label: "Commission reversée",
                value: breakdown.reversedCount > 0 ? formatCurrency(String(Math.abs(breakdown.reversedAmount)), agent.currency) : "—",
                meta: breakdown.reversedCount > 0 ? `${breakdown.reversedCount} commande(s) reprise(s)` : undefined,
                icon: RotateCcw,
                tone: breakdown.reversedCount > 0 ? "danger" : "default",
              },
            ]}
          />
        </CardContent>
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <MetricWithProgress
            label="Commissions gagnées (net, à vie)"
            value={formatCurrency(String(totals.lifetimeNet), agent.currency)}
            hint="Payé vs restant à payer, toutes périodes confondues"
            icon={Scale}
            segments={[
              { label: "Payé", value: Math.max(0, Number(totals.paidTotal)), className: "bg-emerald-500" },
              { label: "Restant", value: Math.max(0, Number(totals.remaining)), className: "bg-amber-500" },
            ]}
          />
        </div>
        <KpiCard
          label="Non clôturé"
          value={formatCurrency(String(totals.unsettledNet), agent.currency)}
          hint={`${totals.unsettledEarnedCount} livrée(s)${totals.unsettledReversedCount > 0 ? `, ${totals.unsettledReversedCount} reprise(s)` : ""}`}
          icon={Clock}
          tone="warning"
        />
      </div>

      {canManage && (
        <Card className="mb-6">
          <CardHeader><CardTitle className="text-[15px]">Configuration</CardTitle></CardHeader>
          <CardContent>
            <AgentRateForm agentId={agent.id} ratePerOrder={agent.ratePerOrder} isActive={agent.isActive} />
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-[15px]">Périodes non clôturées</CardTitle></CardHeader>
        <CardContent>
          {openMonths.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune commission en attente de clôture.</p>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card shadow-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mois</TableHead>
                    <TableHead className="text-right">Livrées</TableHead>
                    <TableHead className="text-right">Reprises</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    {canManage && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openMonths.map((m) => {
                    const isCurrent = m.year === currentPeriod.year && m.month === currentPeriod.month;
                    return (
                      <TableRow key={`${m.year}-${m.month}`}>
                        <TableCell className="font-medium">
                          {MONTH_NAMES[m.month]} {m.year}
                          {isCurrent && <span className="ml-2 text-xs text-muted-foreground">(mois en cours)</span>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{m.earnedCount}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {m.reversedCount > 0 ? `${m.reversedCount} (${formatCurrency(String(m.reversed), agent.currency)})` : "—"}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatCurrency(String(m.net), agent.currency)}
                        </TableCell>
                        {canManage && (
                          <TableCell className="text-right">
                            <ConfirmActionButton
                              label="Clôturer"
                              variant="outline"
                              title={`Clôturer ${MONTH_NAMES[m.month]} ${m.year} ?`}
                              description={`Un relevé figé de ${formatCurrency(String(m.net), agent.currency)} sera créé pour ${agent.userName}. Les commissions de ce mois ne pourront plus changer (une reprise ultérieure ira sur le mois suivant).`}
                              hiddenFields={{ agentId: agent.id, periodYear: String(m.year), periodMonth: String(m.month) }}
                              action={closeCommissionStatementAction}
                              successMessage="Mois clôturé."
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader><CardTitle className="text-[15px]">Relevés mensuels</CardTitle></CardHeader>
        <CardContent>
          {statements.length === 0 ? (
            <EmptyState icon={FileText} title="Aucun relevé clôturé." />
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card shadow-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Période</TableHead>
                    <TableHead className="text-right">Livrées</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                    <TableHead className="text-right">Payé</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Clôturé</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statements.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        {MONTH_NAMES[s.periodMonth]} {s.periodYear}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.earnedCount}
                        {s.reversedCount > 0 && <span className="text-xs text-destructive"> (−{s.reversedCount})</span>}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{formatCurrency(String(s.netAmount), s.currency)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.status === "PAYE" ? formatCurrency(String(s.paidAmount), s.currency) : "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={s.status} labels={STATEMENT_STATUS_LABELS} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(s.closedAt)} · {s.closedByName}
                        {s.paidAt && (
                          <span className="block">Payé {formatDate(s.paidAt)} · {s.paidByName}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Link
                            href={`/commissions/${agent.id}/releves/${s.id}`}
                            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                          >
                            <FileText className="size-3.5" />
                            Facture
                          </Link>
                          {canManage && s.status === "CLOTURE" && (
                            <ConfirmActionButton
                              label="Marquer payé"
                              variant="outline"
                              title={`Marquer ${MONTH_NAMES[s.periodMonth]} ${s.periodYear} comme payé ?`}
                              description={`Enregistre un paiement de ${formatCurrency(String(s.netAmount), s.currency)} à ${agent.userName}.`}
                              hiddenFields={{ statementId: s.id }}
                              action={markCommissionStatementPaidAction}
                              successMessage="Relevé marqué payé."
                            />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-[15px]">Écritures récentes (non clôturées)</CardTitle></CardHeader>
        <CardContent>
          {openEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Rien pour l&apos;instant.</p>
          ) : (
            <div className="overflow-hidden rounded-xl border bg-card shadow-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Commande</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Montant</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {openEntries.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium">
                        <Link href={`/commandes/${e.orderId}`} className="hover:underline">
                          {displayOrderNumber(
                            {
                              orderNumber: e.orderNumber,
                              displayNumber: e.orderDisplayNumber,
                              source: e.orderSource,
                              externalNumber: e.orderExternalNumber,
                            },
                            business.orderNumberPrefix
                          )}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={e.orderStatus} labels={ORDER_STATUS_LABELS} />
                      </TableCell>
                      <TableCell className={e.type === "REVERSED" ? "text-destructive" : ""}>
                        {e.type === "EARNED" ? "Gagnée" : "Reprise"}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums ${e.type === "REVERSED" ? "text-destructive" : ""}`}>
                        {formatCurrency(String(e.amount), agent.currency)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
