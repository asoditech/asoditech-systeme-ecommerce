import Link from "next/link";
import { Truck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { FilterSearchInput } from "@/components/filter-search-input";
import { SupplierForm } from "@/components/purchases/supplier-form";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { listSuppliers } from "@/lib/queries/purchases";
import { formatCurrency } from "@/lib/format";

export const metadata = { title: "Fournisseurs — ASODITECH Gestion E-commerce" };

/** Suppliers and what is owed to each (derived: validated receptions − payments). docs/adr/0040. */
export default async function FournisseursPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const user = await requirePermission("suppliers.view");
  const params = await searchParams;
  const { suppliers, total, page, pageSize } = await listSuppliers({ q: params.q, page: Number(params.page) || 1 });
  const canManage = userHasPermission(user, "suppliers.manage");

  return (
    <div>
      <PageHeader
        title="Fournisseurs"
        description="Vos fournisseurs et le solde restant à leur payer (réceptions validées − paiements)."
        actions={canManage ? <SupplierForm /> : undefined}
      />
      <div className="mb-4">
        <FilterSearchInput placeholder="Nom ou téléphone..." defaultValue={params.q} className="w-64" />
      </div>
      {suppliers.length === 0 ? (
        <EmptyState icon={Truck} title={params.q ? "Aucun fournisseur ne correspond." : "Aucun fournisseur pour le moment."} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Téléphone</TableHead>
                <TableHead>Ville</TableHead>
                <TableHead className="text-right">Reçu</TableHead>
                <TableHead className="text-right">Payé</TableHead>
                <TableHead className="text-right">Solde dû</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">
                    <Link href={`/fournisseurs/${s.id}`} className="hover:underline">
                      {s.name}
                    </Link>
                    {!s.isActive && <Badge variant="secondary" className="ml-2">Inactif</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{s.phone ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{s.city ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(s.totalReceived.toString())}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(s.totalPaid.toString())}</TableCell>
                  <TableCell className={"text-right tabular-nums font-medium " + (s.balance.greaterThan(0) ? "text-destructive" : "")}>
                    {formatCurrency(s.balance.toString())}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/fournisseurs" searchParams={{ q: params.q }} />
        </div>
      )}
    </div>
  );
}
