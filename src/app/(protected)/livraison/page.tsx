import Link from "next/link";
import { Truck, Package2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { CreateShipmentDialog } from "@/components/delivery/create-shipment-dialog";
import { ShipmentStatusSelect } from "@/components/delivery/shipment-status-select";
import { ProviderForm } from "@/components/delivery/provider-form";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import {
  listShippingProviders,
  listShipments,
  getDeliveryStats,
  listOrdersAwaitingShipment,
} from "@/lib/queries/delivery";
import { formatCurrency, formatDate, formatOrderNumber, formatPercent } from "@/lib/format";
import { SHIPMENT_STATUS_LABELS, SHIPPING_PROVIDER_TYPE_LABELS } from "@/lib/status-labels";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

export const metadata = { title: "Livraison — ASODITECH Gestion E-commerce" };

export default async function LivraisonPage() {
  const user = await requirePermission("delivery.view");
  const canManage = hasPermission(user.role, "delivery.manage");

  const [stats, providers, { shipments }, awaitingShipment] = await Promise.all([
    getDeliveryStats(),
    listShippingProviders(),
    listShipments({}),
    canManage ? listOrdersAwaitingShipment() : Promise.resolve([]),
  ]);

  return (
    <div>
      <PageHeader title="Livraison" description="Expéditions, prestataires et taux de livraison réussie." />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Expéditions totales" value={String(stats.total)} />
        <KpiCard label="Livrées" value={String(stats.delivered)} />
        <KpiCard label="Échecs" value={String(stats.failed)} />
        <KpiCard
          label="Taux de livraison réussie"
          value={stats.successRate !== null ? formatPercent(stats.successRate) : null}
          unavailableReason="Aucune expédition"
        />
      </div>

      <Tabs defaultValue="expeditions">
        <TabsList>
          <TabsTrigger value="expeditions">Expéditions</TabsTrigger>
          {canManage && <TabsTrigger value="a-expedier">À expédier ({awaitingShipment.length})</TabsTrigger>}
          <TabsTrigger value="prestataires">Prestataires</TabsTrigger>
        </TabsList>

        <TabsContent value="expeditions">
          {shipments.length === 0 ? (
            <EmptyState icon={Truck} title="Aucune expédition pour le moment." />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Commande</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Prestataire</TableHead>
                    <TableHead>Suivi</TableHead>
                    <TableHead>Statut</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shipments.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">
                        <Link href={`/commandes/${s.orderId}`} className="hover:underline">
                          {formatOrderNumber(s.order.orderNumber)}
                        </Link>
                      </TableCell>
                      <TableCell>{s.order.customer.fullName}</TableCell>
                      <TableCell className="text-muted-foreground">{s.provider.name}</TableCell>
                      <TableCell className="text-muted-foreground">{s.trackingNumber ?? "—"}</TableCell>
                      <TableCell>
                        {canManage ? (
                          <ShipmentStatusSelect shipmentId={s.id} currentStatus={s.status as ShipmentStatusValue} />
                        ) : (
                          <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        {canManage && (
          <TabsContent value="a-expedier">
            {awaitingShipment.length === 0 ? (
              <EmptyState icon={Package2} title="Aucune commande en attente d'expédition." />
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Commande</TableHead>
                      <TableHead>Client</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {awaitingShipment.map((o) => (
                      <TableRow key={o.id}>
                        <TableCell className="font-medium">
                          <Link href={`/commandes/${o.id}`} className="hover:underline">
                            {formatOrderNumber(o.orderNumber)}
                          </Link>
                        </TableCell>
                        <TableCell>{o.customer.fullName}</TableCell>
                        <TableCell>{formatCurrency(o.total.toString(), o.currency)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(o.createdAt)}</TableCell>
                        <TableCell>
                          <CreateShipmentDialog orderId={o.id} providers={providers} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        )}

        <TabsContent value="prestataires" className="space-y-4">
          {providers.length === 0 ? (
            <EmptyState icon={Truck} title="Aucun prestataire de livraison configuré." />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nom</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Expéditions</TableHead>
                    <TableHead>Statut</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providers.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-muted-foreground">{SHIPPING_PROVIDER_TYPE_LABELS[p.type]}</TableCell>
                      <TableCell>{p._count.shipments}</TableCell>
                      <TableCell>
                        <Badge variant={p.isActive ? "default" : "secondary"}>{p.isActive ? "Actif" : "Inactif"}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {canManage && <ProviderForm />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
