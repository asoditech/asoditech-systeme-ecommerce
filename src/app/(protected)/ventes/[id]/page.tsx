import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SaleReturnDialog } from "@/components/sales/sale-return-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { variantLabel } from "@/lib/catalog/lookup";
import { requireChannelKind } from "@/lib/auth/channel-access";
import { userHasPermission } from "@/lib/auth/permissions";
import { getSaleDetail } from "@/lib/queries/sales";
import { displaySaleNumber, displaySaleReturnNumber, formatCurrency, formatDateTime } from "@/lib/format";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Vente — ASODITECH Gestion E-commerce" };

export default async function VenteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("sales.view");
  requireChannelKind(user, "OFFLINE");
  const { id } = await params;
  // Row-scoped: a sale of another store's channel is simply "not found".
  const sale = await getSaleDetail(user, id);
  if (!sale) notFound();

  const refunded = sale.returns.reduce((s, r) => s + Number(r.refundAmount), 0);
  const returnable = sale.lines.map((l) => ({
    id: l.id,
    label: `${l.nameSnapshot} (${l.skuSnapshot})`,
    sold: l.quantity,
    returned: l.returnLines.reduce((s, x) => s + x.quantitySellable + x.quantityDamaged, 0),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={displaySaleNumber(sale)}
        breadcrumbs={[{ label: "Ventes magasin", href: "/ventes" }, { label: displaySaleNumber(sale) }]}
        description={`${sale.salesChannel.name} · ${sale.warehouse.name} · ${formatDateTime(sale.soldAt)} · ${sale.soldByName ?? "—"}${sale.customerLabel ? ` · ${sale.customerLabel}` : ""}`}
        actions={
          userHasPermission(user, "sales.return") ? (
            <SaleReturnDialog saleId={sale.id} lines={returnable} refundable={Number(sale.total) - refunded} />
          ) : undefined
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Articles</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Article</TableHead>
                <TableHead>Réf. / code-barres</TableHead>
                <TableHead className="text-right">Qté</TableHead>
                <TableHead className="text-right">Prix</TableHead>
                <TableHead className="text-right">Remise</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sale.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">
                    {l.nameSnapshot}
                    {variantLabel(l.variation?.attributes) && <span className="font-normal text-muted-foreground"> — {variantLabel(l.variation?.attributes)}</span>}
                    {l.variationId && <div className="font-mono text-xs font-normal text-muted-foreground">{l.skuSnapshot}</div>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{l.barcodeSnapshot ?? l.skuSnapshot}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(l.unitPrice.toString(), sale.currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.discount) > 0 ? formatCurrency(l.discount.toString(), sale.currency) : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(l.total.toString(), sale.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex justify-end text-lg font-semibold tabular-nums">{formatCurrency(sale.total.toString(), sale.currency)}</div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">Paiements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {sale.payments.map((p) => (
              <div key={p.id} className="flex justify-between">
                <span>{CASH_PAYMENT_METHOD_LABELS[p.method]}</span>
                <span className="tabular-nums">{formatCurrency(p.amount.toString(), sale.currency)}</span>
              </div>
            ))}
            {refunded > 0 && (
              <div className="flex justify-between border-t pt-1 text-destructive">
                <span>Remboursé</span>
                <span className="tabular-nums">− {formatCurrency(String(refunded), sale.currency)}</span>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">Retours</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {sale.returns.length === 0 && <p className="text-muted-foreground">Aucun retour.</p>}
            {sale.returns.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{displaySaleReturnNumber(r)}</span>
                <span className="text-muted-foreground">{formatDateTime(r.receivedAt)} · {r.receivedByName ?? "—"}</span>
                <span>
                  {r.lines.map((l) => `${l.quantitySellable} revendable${l.quantityDamaged ? ` / ${l.quantityDamaged} endommagé` : ""}`).join(", ")}
                </span>
                {Number(r.refundAmount) > 0 && <Badge variant="outline">{formatCurrency(r.refundAmount.toString(), sale.currency)}</Badge>}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Stock : chaque ligne a produit un mouvement « Vente » horodaté sur l&apos;emplacement ; consultez-les dans{" "}
        <Link href="/tracabilite" className="underline">Traçabilité</Link>.
      </p>
    </div>
  );
}
