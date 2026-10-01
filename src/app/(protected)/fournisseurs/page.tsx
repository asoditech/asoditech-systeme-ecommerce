import Link from "next/link";
import { Truck, Phone } from "lucide-react";
import { EntityAvatar } from "@/components/entity-avatar";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { DataTablePagination } from "@/components/data-table-pagination";
import { FilterSearchInput } from "@/components/filter-search-input";
import { SupplierForm } from "@/components/purchases/supplier-form";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { productCostVisibility } from "@/lib/auth/cost-visibility";
import { userHasPermission } from "@/lib/auth/permissions";
import { listSuppliers } from "@/lib/queries/purchases";
import { formatCurrency, formatDate } from "@/lib/format";

export const metadata = { title: "Fournisseurs — ASODITECH Gestion E-commerce" };

/** Suppliers and what is owed to each (derived: validated receptions − payments). docs/adr/0040. */
export default async function FournisseursPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const user = await requirePermission("suppliers.view");
  const params = await searchParams;
  const { suppliers, total, page, pageSize } = await listSuppliers({ q: params.q, page: Number(params.page) || 1 }, user);
  const canManage = userHasPermission(user, "suppliers.manage");
  // Amounts received / paid / owed are the supplier ACCOUNT — `finance.view` (docs/adr/0048, 0052).
  const showAmounts = productCostVisibility(user).supplierAccounts;

  return (
    <div>
      <PageHeader
        title="Fournisseurs"
        description={showAmounts ? "Vos fournisseurs et le solde restant à leur payer (réceptions validées − paiements)." : "Vos fournisseurs."}
        actions={canManage ? <SupplierForm /> : undefined}
      />
      <div className="mb-4">
        <FilterSearchInput placeholder="Nom ou téléphone..." defaultValue={params.q} className="w-64" />
      </div>
      {suppliers.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={params.q ? "Aucun fournisseur ne correspond." : "Aucun fournisseur pour le moment."}
          description={
            params.q
              ? "Essayez un autre nom ou numéro de téléphone."
              : canManage
                ? "Ajoutez votre premier fournisseur pour commencer à enregistrer des réceptions."
                : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card shadow-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fournisseur</TableHead>
                <TableHead className="text-right">Activité</TableHead>
                {showAmounts && <TableHead className="text-right">Reçu</TableHead>}
                {showAmounts && <TableHead className="text-right">Payé</TableHead>}
                {showAmounts && <TableHead className="text-right">Solde dû</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((s) => {
                const owes = s.balance.greaterThan(0);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="whitespace-normal">
                      <Link href={`/fournisseurs/${s.id}`} className="group/row flex items-center gap-3">
                        <EntityAvatar name={s.name} className="size-9" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium group-hover/row:underline">{s.name}</span>
                            {!s.isActive && (
                              <Badge variant="secondary" className="shrink-0">
                                Inactif
                              </Badge>
                            )}
                          </span>
                          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                            {s.city ?? "Ville non renseignée"}
                            {s.phone && (
                              <>
                                <span aria-hidden="true">·</span>
                                <Phone className="size-3" />
                                {s.phone}
                              </>
                            )}
                          </span>
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right">
                      <p className="text-sm tabular-nums">{s.receptionCount} réception{s.receptionCount > 1 ? "s" : ""}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.lastReceptionDate ? formatDate(s.lastReceptionDate) : "Aucune réception"}
                      </p>
                    </TableCell>
                    {showAmounts && (
                      <>
                        <TableCell className="text-right tabular-nums">{formatCurrency(s.totalReceived.toString())}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(s.totalPaid.toString())}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={owes ? "warning" : "success"} className="font-semibold tabular-nums">
                            {formatCurrency(s.balance.toString())}
                          </Badge>
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/fournisseurs" searchParams={{ q: params.q }} />
        </div>
      )}
    </div>
  );
}
