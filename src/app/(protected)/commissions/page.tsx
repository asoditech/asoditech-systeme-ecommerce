import Link from "next/link";
import { HandCoins } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listCommissionAgentsWithTotals, listUsersEligibleForAgent } from "@/lib/queries/commissions";
import { formatCurrency } from "@/lib/format";
import { AddAgentForm } from "@/components/commissions/add-agent-form";

export const metadata = { title: "Commissions — ASODITECH Gestion E-commerce" };

export default async function CommissionsPage() {
  const user = await requirePermission("commissions.view");
  const canManage = hasPermission(user.role, "commissions.manage");

  const [agents, eligibleUsers] = await Promise.all([
    listCommissionAgentsWithTotals(),
    canManage ? listUsersEligibleForAgent() : Promise.resolve([]),
  ]);

  const currency = agents[0]?.currency ?? "MAD";
  const totalRemaining = agents.reduce((s, a) => s + a.totals.remaining, 0);
  const totalUnsettled = agents.reduce((s, a) => s + a.totals.unsettledNet, 0);
  const totalPaid = agents.reduce((s, a) => s + a.totals.paidTotal, 0);

  return (
    <div>
      <PageHeader
        title="Commissions de confirmation"
        description="Un montant fixe par commande livrée, crédité automatiquement à l'agent qui l'a confirmée."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Déjà payé</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{formatCurrency(String(totalPaid), currency)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">À clôturer</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{formatCurrency(String(totalUnsettled), currency)}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total à payer</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{formatCurrency(String(totalRemaining), currency)}</CardContent>
        </Card>
      </div>

      {canManage && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-[15px]">Ajouter un agent de confirmation</CardTitle>
          </CardHeader>
          <CardContent>
            <AddAgentForm users={eligibleUsers.map((u) => ({ id: u.id, name: u.name }))} />
          </CardContent>
        </Card>
      )}

      {agents.length === 0 ? (
        <EmptyState icon={HandCoins} title="Aucun agent de confirmation configuré." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead className="text-right">Taux / commande</TableHead>
                <TableHead className="text-right">Confirmées</TableHead>
                <TableHead className="text-right">Livrées</TableHead>
                <TableHead className="text-right">À clôturer</TableHead>
                <TableHead className="text-right">Restant à payer</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link href={`/commissions/${a.id}`} className="font-medium hover:underline">
                      {a.userName}
                    </Link>
                    {!a.isActive && (
                      <Badge variant="secondary" className="ml-2">
                        Inactif
                      </Badge>
                    )}
                    <p className="text-xs text-muted-foreground">{a.userEmail}</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(String(a.ratePerOrder), a.currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{a.pipeline.total}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {a.pipeline.delivered}
                    {a.pipeline.confirmed > 0 && (
                      <span className="text-xs text-muted-foreground"> ({a.pipeline.confirmed} en cours)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(String(a.totals.unsettledNet), a.currency)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCurrency(String(a.totals.remaining), a.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link href={`/commissions/${a.id}`} className="text-sm text-primary hover:underline">
                      Détail →
                    </Link>
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
