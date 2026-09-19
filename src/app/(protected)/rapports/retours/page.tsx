import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReportFilterBar } from "@/components/reports/report-filter-bar";
import { ReportDocumentHeader } from "@/components/reports/report-document-header";
import { requirePermission } from "@/lib/auth/guards";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { resolveReportRange, rangeQuery } from "@/lib/reports/range";
import { getReturnsReport } from "@/lib/queries/reports/returns";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatDateTime, formatOrderNumber } from "@/lib/format";

export const metadata = { title: "Rapport des retours — ASODITECH Gestion E-commerce" };

export default async function RapportRetoursPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const viewer = await requirePermission("analytics.view");
  // Order-derived data: needs an ONLINE channel (docs/adr/0039).
  requireChannelKind(viewer, "ONLINE");
  const params = await searchParams;
  const resolved = resolveReportRange(params);
  const [report, business] = await Promise.all([getReturnsReport(resolved.range), getReportBusinessInfo()]);
  const t = report.totals;

  const exportHref = `/rapports/export/retours?${rangeQuery(resolved)}`;

  return (
    <div>
      <ReportDocumentHeader business={business} title="Rapport des retours" periodLabel={resolved.label} />
      <PageHeader
        title="Rapport des retours"
        description={`Période : ${resolved.label} — retours physiques confirmés (« Confirmer le retour physique ») dans la fenêtre.`}
      />
      <ReportFilterBar basePath="/rapports/retours" resolved={resolved} exportHref={exportHref} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Retours enregistrés" value={String(t.returnEvents)} tone="primary"
          hint={`${t.ordersReturned} commande${t.ordersReturned > 1 ? "s" : ""} concernée${t.ordersReturned > 1 ? "s" : ""}`} />
        <KpiCard label="Unités revendables" value={String(t.unitsSellable)} tone="success"
          hint="Recréditées au stock disponible" />
        <KpiCard label="Unités endommagées" value={String(t.unitsDamaged)} tone="danger"
          hint="Jamais remises en vente" />
        <KpiCard label="Total unités reçues" value={String(t.unitsTotal)} tone="info" />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle>Par produit</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>Produit</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Revendables</TableHead>
                <TableHead className="text-right">Endommagées</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.byProduct.map((p) => (
                <TableRow key={p.key}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground">{p.sku || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.unitsSellable}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.unitsDamaged}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{p.unitsTotal}</TableCell>
                </TableRow>
              ))}
              {report.byProduct.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    Aucun retour sur la période.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader><CardTitle>Par commande</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Reçu par</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Revendables</TableHead>
                <TableHead className="text-right">Endommagées</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.byOrder.map((o) => (
                <TableRow key={o.orderReturnId}>
                  <TableCell>
                    <Link href={`/commandes/${o.orderId}`} className="font-medium hover:underline">
                      {formatOrderNumber(o.displayNumber ?? o.orderNumber)}
                    </Link>
                  </TableCell>
                  <TableCell>{o.customerName}</TableCell>
                  <TableCell className="text-muted-foreground">{o.receivedByName ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDateTime(o.receivedAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.unitsSellable}</TableCell>
                  <TableCell className="text-right tabular-nums">{o.unitsDamaged}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground">{o.note ?? "—"}</TableCell>
                </TableRow>
              ))}
              {report.byOrder.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Aucun retour sur la période.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
