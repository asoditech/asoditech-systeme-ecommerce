import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ReceptionActions } from "@/components/purchases/reception-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { variantLabel } from "@/lib/catalog/lookup";
import { userHasPermission } from "@/lib/auth/permissions";
import { getReceptionDetail } from "@/lib/queries/purchases";
import { displayReceptionNumber, formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { RECEPTION_STATUS_LABELS, CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Réception — ASODITECH Gestion E-commerce" };

export default async function ReceptionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("purchases.view");
  const { id } = await params;
  const r = await getReceptionDetail(id);
  if (!r) notFound();
  const isDraft = r.status === "BROUILLON";
  const canWrite = userHasPermission(user, "purchases.create");
  const total = r.lines.reduce((s, l) => s + l.quantity * Number(l.unitCost), 0);
  const paid = r.payments.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={displayReceptionNumber(r)}
        breadcrumbs={[{ label: "Réceptions", href: "/receptions" }, { label: displayReceptionNumber(r) }]}
        description={
          <span>
            <Link href={`/fournisseurs/${r.supplier.id}`} className="underline">
              {r.supplier.name}
            </Link>{" "}
            → {r.warehouse.name} · {formatDate(r.receptionDate)}
            {r.supplierReference ? ` · Réf. fournisseur ${r.supplierReference}` : ""}
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={r.status} labels={RECEPTION_STATUS_LABELS} />
            {isDraft && canWrite && (
              <Button variant="outline" render={<Link href={`/receptions/${r.id}/modifier`} />}>
                Modifier
              </Button>
            )}
          </div>
        }
      />
      {isDraft && canWrite && <ReceptionActions id={r.id} />}

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
                <TableHead className="text-right">Quantité</TableHead>
                <TableHead className="text-right">Prix d&apos;achat</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">
                    {l.nameSnapshot}
                    {variantLabel(l.variation?.attributes) && <span className="font-normal text-muted-foreground"> — {variantLabel(l.variation?.attributes)}</span>}
                    {l.variationId && <div className="font-mono text-xs font-normal text-muted-foreground">{l.skuSnapshot}</div>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{l.barcodeSnapshot ?? l.skuSnapshot}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(l.unitCost.toString())}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(String(l.quantity * Number(l.unitCost)))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3 flex justify-end gap-6 text-sm">
            <span className="text-muted-foreground">Total : <strong className="tabular-nums text-foreground">{formatCurrency(String(total))}</strong></span>
            {r.status === "VALIDEE" && (
              <span className="text-muted-foreground">Payé : <strong className="tabular-nums text-foreground">{formatCurrency(String(paid))}</strong> · Reste : <strong className="tabular-nums text-foreground">{formatCurrency(String(total - paid))}</strong></span>
            )}
          </div>
          {r.status === "VALIDEE" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Validée par {r.validatedByName ?? "—"} le {r.validatedAt ? formatDateTime(r.validatedAt) : "—"}. Une réception validée est
              définitive : elle n&apos;est ni modifiée ni supprimée (le stock qu&apos;elle a ajouté reste tracé dans le journal des mouvements).
            </p>
          )}
        </CardContent>
      </Card>

      {r.payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">Paiements liés</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableBody>
                {r.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{formatDate(p.paidAt)}</TableCell>
                    <TableCell>{CASH_PAYMENT_METHOD_LABELS[p.method]}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(p.amount.toString())}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
