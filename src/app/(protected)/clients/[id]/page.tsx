import { notFound } from "next/navigation";
import { MapPin, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { CustomerForm } from "@/components/customers/customer-form";
import { CustomerAddressForm } from "@/components/customers/customer-address-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getCustomerDetail, getCustomerStats } from "@/lib/queries/customers";
import { deleteCustomerAddressAction } from "@/actions/customers";
import { formatCurrency, formatDate, formatOrderNumber } from "@/lib/format";
import { ORDER_STATUS_LABELS, CUSTOMER_SEGMENT_LABELS } from "@/lib/status-labels";

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("customers.view");
  const { id } = await params;
  const customer = await getCustomerDetail(id);
  if (!customer) notFound();

  const stats = await getCustomerStats(id);
  const canEdit = hasPermission(user.role, "customers.edit");

  return (
    <div>
      <PageHeader
        title={customer.fullName}
        breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: customer.fullName }]}
        actions={
          customer.segment ? <Badge variant="secondary">{CUSTOMER_SEGMENT_LABELS[customer.segment]}</Badge> : undefined
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Total dépensé" value={stats.totalSpent ? formatCurrency(stats.totalSpent.toString()) : "0,00 MAD"} />
        <KpiCard label="Commandes" value={String(stats.ordersCount)} />
        <KpiCard
          label="Panier moyen"
          value={stats.avgOrderValue ? formatCurrency(stats.avgOrderValue.toString()) : null}
          unavailableReason="Aucune commande"
        />
        <KpiCard
          label="Dernière commande"
          value={stats.lastOrderAt ? formatDate(stats.lastOrderAt) : null}
          unavailableReason="Aucune commande"
        />
      </div>

      <Tabs defaultValue="commandes">
        <TabsList>
          <TabsTrigger value="commandes">Commandes</TabsTrigger>
          <TabsTrigger value="adresses">Adresses</TabsTrigger>
          {canEdit && <TabsTrigger value="infos">Informations</TabsTrigger>}
        </TabsList>

        <TabsContent value="commandes">
          {customer.orders.length === 0 ? (
            <EmptyState icon={Plus} title="Aucune commande pour ce client." />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Commande</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customer.orders.map((o) => (
                    <ClickableTableRow key={o.id} href={`/commandes/${o.id}`}>
                      <TableCell className="font-medium">{formatOrderNumber(o.orderNumber)}</TableCell>
                      <TableCell>
                        <StatusBadge status={o.status} labels={ORDER_STATUS_LABELS} />
                      </TableCell>
                      <TableCell>{formatCurrency(o.total.toString(), o.currency)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(o.createdAt)}</TableCell>
                    </ClickableTableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="adresses" className="space-y-4">
          {customer.addresses.length === 0 ? (
            <EmptyState icon={MapPin} title="Aucune adresse enregistrée." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {customer.addresses.map((a) => (
                <Card key={a.id}>
                  <CardContent className="flex items-start justify-between gap-2 pt-5">
                    <div className="text-sm">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{a.label ?? "Adresse"}</p>
                        {a.isDefault && <Badge variant="default">Par défaut</Badge>}
                      </div>
                      <p className="text-muted-foreground">{a.addressLine1}</p>
                      {a.addressLine2 && <p className="text-muted-foreground">{a.addressLine2}</p>}
                      <p className="text-muted-foreground">
                        {a.city}
                        {a.region ? `, ${a.region}` : ""}, {a.country}
                      </p>
                      {a.phone && <p className="text-muted-foreground">{a.phone}</p>}
                    </div>
                    {canEdit && (
                      <ConfirmActionButton
                        label="Supprimer"
                        variant="ghost"
                        title="Supprimer cette adresse ?"
                        description="Cette action est irréversible."
                        hiddenFields={{ id: a.id, customerId: customer.id }}
                        action={deleteCustomerAddressAction}
                        successMessage="Adresse supprimée."
                        destructive
                      />
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {canEdit && <CustomerAddressForm customerId={customer.id} />}
        </TabsContent>

        {canEdit && (
          <TabsContent value="infos">
            <div className="max-w-2xl">
              <CustomerForm customer={customer} />
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
