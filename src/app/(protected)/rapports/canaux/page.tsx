import Link from "next/link";
import { Globe, Store, Sigma } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { requireCapability } from "@/lib/auth/capabilities";
import { listAccessibleChannels } from "@/lib/auth/channel-access";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { getChannelReport } from "@/lib/queries/reports/channels";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency } from "@/lib/format";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Rapport par canal — ASODITECH Gestion E-commerce" };

/**
 * Online / Offline / Total (docs/adr/0040), from the underlying sources — Orders
 * for Online, Sales for Offline — never from duplicated rows. Each section only
 * appears if the viewer holds a channel of that activity, and the Total only when
 * they hold both (docs/adr/0039): the report cannot leak an activity the viewer
 * has no channel for, not even inside an aggregate.
 */
export default async function RapportCanauxPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string; kind?: string; canal?: string }>;
}) {
  const viewer = await requirePermission("analytics.view");
  requireCapability(viewer, "storeChannels"); // docs/adr/0041
  const params = await searchParams;
  const kind = params.kind === "online" || params.kind === "offline" ? params.kind : "all";
  const stores = await listAccessibleChannels(viewer, "OFFLINE");
  const salesChannelId = stores.some((s) => s.id === params.canal) ? params.canal : undefined;

  const resolved = resolveReportRange(params);
  const [report, business] = await Promise.all([
    getChannelReport(viewer, resolved.range, { kind, salesChannelId }),
    getReportBusinessInfo(),
  ]);
  const base = rangeQuery(resolved);
  const link = (extra: string) => `/rapports/canaux?${base}${extra}`;

  if (!report.online && !report.offline) {
    return (
      <div>
        <PageHeader title="Rapport par canal" description="Aucun canal accessible avec ces filtres." />
      </div>
    );
  }
  const both = viewer.channels.online && viewer.channels.offline;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport par canal" periodLabel={resolved.label} />
      <PageHeader title="Rapport par canal" description={`Période : ${resolved.label} — En ligne, Magasin et Total, sans double comptage.`} />
      <ReportFilterBar basePath="/rapports/canaux" resolved={resolved} exportHref={`/rapports/export/canaux?${base}`} />

      {both && (
        <div className="mb-4 flex flex-wrap gap-1">
          {(["all", "online", "offline"] as const).map((k) => (
            <Button key={k} size="sm" variant={k === kind ? "default" : "outline"} render={<Link href={link(k === "all" ? "" : `&kind=${k}`)} />}>
              {k === "all" ? "Tout" : k === "online" ? "En ligne" : "Magasin"}
            </Button>
          ))}
        </div>
      )}
      {stores.length > 1 && kind !== "online" && (
        <div className="mb-4 flex flex-wrap gap-1">
          <Button size="sm" variant={!salesChannelId ? "default" : "outline"} render={<Link href={link(kind === "all" ? "" : `&kind=${kind}`)} />}>
            Tous les magasins
          </Button>
          {stores.map((s) => (
            <Button key={s.id} size="sm" variant={salesChannelId === s.id ? "default" : "outline"} render={<Link href={link(`&kind=offline&canal=${s.id}`)} />}>
              {s.name}
            </Button>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {report.online && (
          <KpiCard label="En ligne — chiffre d'affaires" value={formatCurrency(report.online.revenue)} icon={Globe} tone="info" hint={`${report.online.ordersCount} commande(s) — définition inchangée`} />
        )}
        {report.offline && (
          <KpiCard label="Magasin — ventes nettes" value={formatCurrency(report.offline.netSales)} icon={Store} tone="primary" hint={`${report.offline.salesCount} vente(s), ${report.offline.unitsSold} article(s)`} />
        )}
        {report.total && <KpiCard label="Total" value={formatCurrency(report.total.revenue)} icon={Sigma} tone="success" hint="En ligne + Magasin net" />}
      </div>

      {report.offline && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Magasin — détail</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between"><span>Ventes brutes</span><span className="tabular-nums">{formatCurrency(report.offline.grossSales)}</span></div>
              <div className="flex justify-between text-destructive"><span>Remboursements (retours de la période)</span><span className="tabular-nums">− {formatCurrency(report.offline.refunds)}</span></div>
              <div className="flex justify-between border-t pt-1 font-medium"><span>Ventes nettes</span><span className="tabular-nums">{formatCurrency(report.offline.netSales)}</span></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Par mode de paiement</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableBody>
                  {report.offline.byPayment.map((p) => (
                    <TableRow key={p.method}>
                      <TableCell>{CASH_PAYMENT_METHOD_LABELS[p.method]}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(p.amount)}</TableCell>
                    </TableRow>
                  ))}
                  {report.offline.byPayment.length === 0 && (
                    <TableRow><TableCell className="text-muted-foreground">Aucun encaissement.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Par magasin</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Canal</TableHead><TableHead className="text-right">Ventes</TableHead><TableHead className="text-right">Montant</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.offline.byChannel.map((c) => (
                    <TableRow key={c.channelId}><TableCell>{c.name}</TableCell><TableCell className="text-right tabular-nums">{c.count}</TableCell><TableCell className="text-right tabular-nums">{formatCurrency(c.gross)}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Par emplacement</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Emplacement</TableHead><TableHead className="text-right">Ventes</TableHead><TableHead className="text-right">Montant</TableHead></TableRow></TableHeader>
                <TableBody>
                  {report.offline.byLocation.map((w) => (
                    <TableRow key={w.warehouseId}><TableCell>{w.name}</TableCell><TableCell className="text-right tabular-nums">{w.count}</TableCell><TableCell className="text-right tabular-nums">{formatCurrency(w.gross)}</TableCell></TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      )}

      <p className="mt-6 max-w-3xl text-xs text-muted-foreground">
        <strong>Définitions.</strong> <em>En ligne</em> : commandes passées sur la période, hors annulées / échouées / retournées / remboursées
        (définition existante, inchangée — le chiffre est reconnu à la commande, avant livraison). <em>Magasin</em> : ventes encaissées à la
        date de vente, nettes des remboursements versés sur des retours de la période. <em>Total</em> : la somme des deux sources, sans
        double comptage — les deux moments de reconnaissance diffèrent, ce n&apos;est pas un résultat comptable.
      </p>
    </div>
  );
}
