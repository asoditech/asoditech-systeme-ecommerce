import Link from "next/link";
import { Truck, Package2, PackageCheck, PackageX, Percent } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { CreateShipmentDialog } from "@/components/delivery/create-shipment-dialog";
import { ShipmentStatusSelect } from "@/components/delivery/shipment-status-select";
import { ProviderForm } from "@/components/delivery/provider-form";
import { ProviderConnectionStatus, ProviderConnectionControls } from "@/components/delivery/provider-connection";
import { ShipmentProviderControls } from "@/components/delivery/shipment-provider-controls";
import { ConfirmActionButton } from "@/components/confirm-action-button";
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
  listAvailableDeliveryConnectors,
} from "@/lib/queries/delivery";
import { deleteShippingProviderAction } from "@/actions/delivery";
import { formatCurrency, formatDate, formatOrderNumber, formatPercent } from "@/lib/format";
import { SHIPMENT_STATUS_LABELS, SHIPPING_PROVIDER_TYPE_LABELS } from "@/lib/status-labels";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

export const metadata = { title: "Livraison — ASODITECH Gestion E-commerce" };

const TERMINAL_SHIPMENT_STATUSES = ["LIVRE", "ANNULE", "RETOURNE"];

export default async function LivraisonPage() {
  const user = await requirePermission("delivery.view");
  const canManage = hasPermission(user.role, "delivery.manage");

  const [stats, providers, { shipments }, awaitingShipment, connectors] = await Promise.all([
    getDeliveryStats(),
    listShippingProviders(),
    listShipments({}),
    canManage ? listOrdersAwaitingShipment() : Promise.resolve([]),
    listAvailableDeliveryConnectors(),
  ]);

  return (
    <div>
      <PageHeader title="Livraison" description="Expéditions, prestataires et taux de livraison réussie." />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Expéditions totales" value={String(stats.total)} icon={Truck} tone="primary" />
        <KpiCard label="Livrées" value={String(stats.delivered)} icon={PackageCheck} tone="success" />
        <KpiCard label="Échecs" value={String(stats.failed)} icon={PackageX} tone="danger" />
        <KpiCard
          label="Taux de livraison réussie"
          value={stats.successRate !== null ? formatPercent(stats.successRate) : null}
          unavailableReason="Aucune expédition"
          icon={Percent}
          tone="info"
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
                    <TableHead>Coût</TableHead>
                    <TableHead>Statut</TableHead>
                    {canManage && <TableHead />}
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
                      <TableCell className="text-muted-foreground">
                        {s.trackingUrl ? (
                          <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="hover:underline">
                            {s.trackingNumber ?? "Suivre"}
                          </a>
                        ) : (
                          (s.trackingNumber ?? "—")
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {s.cost !== null ? formatCurrency(s.cost.toString(), s.order.currency) : "Non disponible"}
                      </TableCell>
                      <TableCell>
                        {canManage ? (
                          <ShipmentStatusSelect shipmentId={s.id} currentStatus={s.status as ShipmentStatusValue} />
                        ) : (
                          <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          {s.externalId && (
                            <ShipmentProviderControls
                              shipmentId={s.id}
                              canCancel={!TERMINAL_SHIPMENT_STATUSES.includes(s.status)}
                            />
                          )}
                        </TableCell>
                      )}
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
                    <TableHead>Actif</TableHead>
                    <TableHead>Connexion</TableHead>
                    {canManage && <TableHead />}
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
                      <TableCell>{p.type === "API" ? <ProviderConnectionStatus status={p.connectionStatus} /> : "—"}</TableCell>
                      {canManage && (
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            {p.type === "API" && (
                              <ProviderConnectionControls providerId={p.id} providerKey={p.providerKey} connectors={connectors} />
                            )}
                            <ConfirmActionButton
                              label="Supprimer"
                              variant="ghost"
                              destructive
                              disabled={p._count.shipments > 0}
                              title={`Supprimer « ${p.name} » ?`}
                              description={
                                p._count.shipments > 0
                                  ? "Ce prestataire a des expéditions rattachées et ne peut pas être supprimé. Désactivez-le pour ne plus l'utiliser."
                                  : "Cette action est définitive. Le prestataire et sa configuration (identifiants chiffrés inclus) seront supprimés."
                              }
                              hiddenFields={{ id: p.id }}
                              action={deleteShippingProviderAction}
                              successMessage="Prestataire supprimé."
                            />
                          </div>
                        </TableCell>
                      )}
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
