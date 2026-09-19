import Link from "next/link";
import { notFound } from "next/navigation";
import { Wallet, PackageCheck, Scale } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { KpiCard } from "@/components/kpi-card";
import { StatusBadge } from "@/components/status-badge";
import { SupplierForm } from "@/components/purchases/supplier-form";
import { SupplierPaymentForm } from "@/components/purchases/supplier-payment-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { getSupplierDetail } from "@/lib/queries/purchases";
import { displayReceptionNumber, formatCurrency, formatDate } from "@/lib/format";
import { RECEPTION_STATUS_LABELS, CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Fournisseur — ASODITECH Gestion E-commerce" };

export default async function FournisseurDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("suppliers.view");
  const { id } = await params;
  const detail = await getSupplierDetail(id);
  if (!detail) notFound();
  const { supplier, balance, payments, receptions } = detail;
  const canManage = userHasPermission(user, "suppliers.manage");
  const canPay = userHasPermission(user, "purchases.pay");
  const payable = receptions
    .filter((r) => r.status === "VALIDEE" && r.totalCost.minus(r.paid).greaterThan(0))
    .map((r) => ({ id: r.id, label: displayReceptionNumber(r), remaining: formatCurrency(r.totalCost.minus(r.paid).toString()) }));

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
        <KpiCard label="Total reçu (validé)" value={formatCurrency(balance.totalReceived.toString())} icon={PackageCheck} tone="info" />
        <KpiCard label="Total payé" value={formatCurrency(balance.totalPaid.toString())} icon={Wallet} tone="success" />
        <KpiCard label="Solde dû" value={formatCurrency(balance.balance.toString())} icon={Scale} tone={balance.balance.greaterThan(0) ? "danger" : "primary"} />
      </div>

      {canPay && <SupplierPaymentForm supplierId={supplier.id} receptions={payable} />}

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
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.totalCost.toString())}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.paid.toString())}</TableCell>
                </TableRow>
              ))}
              {receptions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Aucune réception.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Paiements</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
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
                  <TableCell>{CASH_PAYMENT_METHOD_LABELS[p.method]}</TableCell>
                  <TableCell className="text-muted-foreground">{p.reference ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{p.createdByName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(p.amount.toString())}</TableCell>
                </TableRow>
              ))}
              {payments.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
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
