import Link from "next/link";
import { notFound } from "next/navigation";
import { PackageCheck, Scale } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { MetricWithProgress } from "@/components/metric-with-progress";
import { ProductMetricRow } from "@/components/products/product-metric-row";
import { StatusBadge } from "@/components/status-badge";
import { SupplierForm } from "@/components/purchases/supplier-form";
import { SupplierPaymentForm } from "@/components/purchases/supplier-payment-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { getSupplierDetail, getSupplierPurchaseHistory } from "@/lib/queries/purchases";
import { displayReceptionNumber, formatCurrency, formatDate } from "@/lib/format";
import { RECEPTION_STATUS_LABELS, RECEPTION_PAYMENT_STATUS_LABELS, CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";
import type { Prisma } from "@prisma/client";

/** Non payé / Partiellement payé / Payé — only meaningful once a reception is VALIDATED (docs/adr/0042). */
function receptionPaymentStatus(totalCost: Prisma.Decimal, paid: Prisma.Decimal): string {
  if (paid.lessThanOrEqualTo(0)) return "NON_PAYE";
  if (paid.greaterThanOrEqualTo(totalCost)) return "PAYE";
  return "PARTIEL";
}

export const metadata = { title: "Fournisseur — ASODITECH Gestion E-commerce" };

export default async function FournisseurDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("suppliers.view");
  const { id } = await params;
  const canViewPurchases = userHasPermission(user, "purchases.view");
  const [detail, purchaseHistory] = await Promise.all([
    getSupplierDetail(id),
    canViewPurchases ? getSupplierPurchaseHistory(id, 30) : Promise.resolve([]),
  ]);
  if (!detail) notFound();
  const { supplier, balance, payments, receptions } = detail;
  const canManage = userHasPermission(user, "suppliers.manage");
  const canPay = userHasPermission(user, "purchases.pay");

  return (
    <div className="space-y-6">
      <PageHeader
        title={supplier.name}
        breadcrumbs={[{ label: "Fournisseurs", href: "/fournisseurs" }, { label: supplier.name }]}
        description={[supplier.city, supplier.phone, supplier.email].filter(Boolean).join(" · ") || undefined}
        actions={
          canManage ? (
            <SupplierForm
              supplier={{
                id: supplier.id,
                name: supplier.name,
                phone: supplier.phone,
                email: supplier.email,
                address: supplier.address,
                city: supplier.city,
                notes: supplier.notes,
                isActive: supplier.isActive,
              }}
            />
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <MetricWithProgress
            label="Solde dû au fournisseur"
            value={formatCurrency(balance.balance.toString())}
            hint={
              receptions.length > 0
                ? `${receptions.length} réception(s) · dernière le ${formatDate(receptions[0].receptionDate)}`
                : "Aucune réception"
            }
            icon={Scale}
            segments={[
              { label: "Payé", value: Math.max(0, Number(balance.totalPaid)), className: "bg-emerald-500" },
              { label: "Restant", value: Math.max(0, Number(balance.balance)), className: "bg-amber-500" },
            ]}
          />
        </div>
        <KpiCard label="Total reçu (validé)" value={formatCurrency(balance.totalReceived.toString())} icon={PackageCheck} tone="info" />
      </div>

      {canPay && <SupplierPaymentForm supplierId={supplier.id} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Réceptions</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>N°</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Emplacement</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Paiement</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Payé</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receptions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    <Link href={`/receptions/${r.id}`} className="hover:underline">
                      {displayReceptionNumber(r)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(r.receptionDate)}</TableCell>
                  <TableCell className="text-muted-foreground">{r.warehouse.name}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} labels={RECEPTION_STATUS_LABELS} />
                  </TableCell>
                  <TableCell>
                    {r.status === "VALIDEE" && (
                      <StatusBadge status={receptionPaymentStatus(r.totalCost, r.paid)} labels={RECEPTION_PAYMENT_STATUS_LABELS} />
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.totalCost.toString())}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.paid.toString())}</TableCell>
                </TableRow>
              ))}
              {receptions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Aucune réception.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {canViewPurchases && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">Produits achetés</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <p className="px-6 pb-3 text-xs text-muted-foreground">
              Lignes des réceptions validées de ce fournisseur — les {purchaseHistory.length} plus récentes.
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Article</TableHead>
                    <TableHead className="text-right">Quantité</TableHead>
                    <TableHead className="text-right">Prix unitaire</TableHead>
                    <TableHead>Réception</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchaseHistory.map((l, i) => (
                    <TableRow key={`${l.receptionId}-${i}`}>
                      <TableCell className="text-muted-foreground">{formatDate(l.date)}</TableCell>
                      <TableCell>
                        <ProductMetricRow name={l.productName} sku={l.sku} variantLabel={l.variantLabel} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(String(l.unitCost))}</TableCell>
                      <TableCell>
                        <Link
                          href={`/receptions/${l.receptionId}`}
                          className="hover:underline"
                        >
                          {displayReceptionNumber({ receptionNumber: l.receptionNumber, displayNumber: l.receptionDisplayNumber })}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                  {purchaseHistory.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        Aucun achat validé pour le moment.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Paiements</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Réception</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Référence</TableHead>
                <TableHead>Par</TableHead>
                <TableHead className="text-right">Montant</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">{formatDate(p.paidAt)}</TableCell>
                  <TableCell>
                    {p.reception ? (
                      <Link href={`/receptions/${p.receptionId}`} className="hover:underline">
                        {displayReceptionNumber(p.reception)}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Compte fournisseur</span>
                    )}
                  </TableCell>
                  <TableCell>{CASH_PAYMENT_METHOD_LABELS[p.method]}</TableCell>
                  <TableCell className="text-muted-foreground">{p.reference ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{p.createdByName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(p.amount.toString())}</TableCell>
                </TableRow>
              ))}
              {payments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Aucun paiement.
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
