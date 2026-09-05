import { notFound } from "next/navigation";
import { MapPin, Plus, Wallet, ShoppingCart, Receipt, CalendarClock, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { CustomerForm } from "@/components/customers/customer-form";
import { CustomerAddressForm } from "@/components/customers/customer-address-form";
import { CustomerBlacklistControl } from "@/components/customers/blacklist-control";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getCustomerDetail, getCustomerStats } from "@/lib/queries/customers";
import { deleteCustomerAddressAction } from "@/actions/customers";
import { formatCurrency, formatDate, displayOrderNumber } from "@/lib/format";
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
          <div className="flex items-center gap-2">
            {customer.isBlacklisted && (
              <Badge variant="destructive">
                <ShieldAlert className="size-3.5" />
                Indésirable
              </Badge>
            )}
            {customer.segment && <Badge variant="secondary">{CUSTOMER_SEGMENT_LABELS[customer.segment]}</Badge>}
          </div>
        }
      />

      {canEdit && (customer.isBlacklisted || stats.cancelledOrders >= 2) && (
        <div
          className={
            customer.isBlacklisted
              ? "mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
              : "mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-700 dark:text-amber-400"
          }
        >
          <div>
            {customer.isBlacklisted ? (
              <>
                <p className="font-medium text-destructive">Ce client est marqué comme indésirable.</p>
                {customer.blacklistReason && (
                  <p className="text-muted-foreground">Motif : {customer.blacklistReason}</p>
                )}
              </>
            ) : (
              <p>
                <span className="font-medium">{stats.cancelledOrders} commandes annulées.</span> Envisagez de
                marquer ce client comme indésirable si ce comportement se répète.
              </p>
            )}
          </div>
          <CustomerBlacklistControl customerId={customer.id} isBlacklisted={customer.isBlacklisted} />
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total dépensé"
          value={stats.totalSpent ? formatCurrency(stats.totalSpent.toString()) : "0,00 MAD"}
          icon={Wallet}
          tone="primary"
        />
        <KpiCard label="Commandes" value={String(stats.ordersCount)} icon={ShoppingCart} tone="violet" />
        <KpiCard
          label="Panier moyen"
          value={stats.avgOrderValue ? formatCurrency(stats.avgOrderValue.toString()) : null}
          unavailableReason="Aucune commande"
          icon={Receipt}
          tone="success"
        />
        <KpiCard
          label="Dernière commande"
          tone="info"
          value={stats.lastOrderAt ? formatDate(stats.lastOrderAt) : null}
          unavailableReason="Aucune commande"
          icon={CalendarClock}
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
                      <TableCell className="font-medium">{displayOrderNumber(o)}</TableCell>
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
          <TabsContent value="infos" className="space-y-6">
            <div className="max-w-2xl">
              <CustomerForm customer={customer} />
            </div>
            <div className="max-w-2xl space-y-1.5 border-t pt-4">
              <p className="text-sm font-medium">Liste indésirable</p>
              <p className="text-sm text-muted-foreground">
                {customer.isBlacklisted
                  ? "Ce client est actuellement marqué comme indésirable."
                  : `${stats.cancelledOrders} commande(s) annulée(s) au total. Toujours une décision manuelle — rien ici ne marque un client automatiquement.`}
              </p>
              <CustomerBlacklistControl customerId={customer.id} isBlacklisted={customer.isBlacklisted} />
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
