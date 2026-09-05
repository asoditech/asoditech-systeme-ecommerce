import Link from "next/link";
import { Truck, Package2, PackageCheck, PackageX, Percent, FileText, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import { CreateShipmentDialog, type ShipmentProviderOption } from "@/components/delivery/create-shipment-dialog";
import { ShipmentStatusSelect } from "@/components/delivery/shipment-status-select";
import { ProviderForm } from "@/components/delivery/provider-form";
import { ProviderConnectionStatus, ProviderConnectionControls } from "@/components/delivery/provider-connection";
import { CityMappingDialog } from "@/components/delivery/city-mapping-dialog";
import { ShipmentProviderControls } from "@/components/delivery/shipment-provider-controls";
import { ManifestBuilder, type ManifestableShipment } from "@/components/delivery/manifest-builder";
import { DeliveryDocs } from "@/components/delivery/delivery-docs";
import { LivraisonDateFilter } from "@/components/delivery/livraison-date-filter";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTablePagination } from "@/components/data-table-pagination";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import {
  listShippingProviders,
  listShipments,
  getDeliveryStats,
  listOrdersAwaitingShipment,
  listAvailableDeliveryConnectors,
  listManifestableShipments,
  listDeliveryManifests,
} from "@/lib/queries/delivery";
import { deleteShippingProviderAction } from "@/actions/delivery";
import { formatCurrency, formatDate, formatDateTime, displayOrderNumber, formatPercent } from "@/lib/format";
import {
  SHIPMENT_STATUS_LABELS,
  SHIPPING_PROVIDER_TYPE_LABELS,
  DELIVERY_MANIFEST_STATUS_LABELS,
} from "@/lib/status-labels";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { resolveDateRangePreset, DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";

export const metadata = { title: "Livraison — ASODITECH Gestion E-commerce" };

const TERMINAL_SHIPMENT_STATUSES = ["LIVRE", "ANNULE", "RETOURNE"];

export default async function LivraisonPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; dateFrom?: string; dateTo?: string; page?: string }>;
}) {
  const user = await requirePermission("delivery.view");
  const canManage = hasPermission(user.role, "delivery.manage");
  const params = await searchParams;
  const page = Number(params.page) || 1;

  const rangeParam: DateRangePreset =
    params.range && params.range in DATE_RANGE_PRESET_LABELS ? (params.range as DateRangePreset) : "all";
  // Filling a date input alone is enough — no need to also switch the
  // dropdown to "Période personnalisée".
  const preset: DateRangePreset = params.dateFrom || params.dateTo ? "custom" : rangeParam;
  const { from: dateFrom, to: dateTo } = resolveDateRangePreset(preset, new Date(), {
    from: params.dateFrom,
    to: params.dateTo,
  });

  const [stats, providers, shipmentsResult, awaitingShipment, connectors, manifestable, manifests] =
    await Promise.all([
      getDeliveryStats(dateFrom, dateTo),
      listShippingProviders(),
      listShipments({ dateFrom, dateTo, page }),
      canManage ? listOrdersAwaitingShipment() : Promise.resolve([]),
      listAvailableDeliveryConnectors(),
      canManage ? listManifestableShipments() : Promise.resolve([]),
      canManage ? listDeliveryManifests() : Promise.resolve([]),
    ]);
  const { shipments, total: shipmentsTotal, pageSize: shipmentsPageSize } = shipmentsResult;

  // Only carriers whose registered adapter declares GENERATE_MANIFEST get
  // the Bons de livraison workflow at all.
  const manifestCapableKeys = new Set(
    connectors.filter((c) => c.capabilities.includes("GENERATE_MANIFEST")).map((c) => c.key)
  );
  const showManifestTab =
    canManage &&
    providers.some((p) => p.type === "API" && p.providerKey && manifestCapableKeys.has(p.providerKey));

  // Deliberately narrowed before crossing into the Client Component below —
  // `providers` (the full ShippingProvider row) carries credentialsEncrypted
  // and raw adapter config, neither of which belongs in the client-side RSC
  // payload. See CreateShipmentDialog's own doc comment. Phase 30 hardening.
  const shipmentProviderOptions: ShipmentProviderOption[] = providers.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    connectionStatus: p.connectionStatus,
  }));

  const manifestableShipments: ManifestableShipment[] = manifestable
    .filter((s) => s.provider.providerKey && manifestCapableKeys.has(s.provider.providerKey))
    .map((s) => ({
      id: s.id,
      trackingNumber: s.trackingNumber,
      orderId: s.orderId,
      orderNumber: s.order.orderNumber,
      source: s.order.source,
      externalNumber: s.order.externalNumber,
      customerName: s.order.customer.fullName,
      cityLabel: s.order.shippingCity ?? null,
      cost: s.cost !== null ? s.cost.toString() : null,
      currency: s.order.currency,
      providerId: s.providerId,
      providerName: s.provider.name,
    }));

  return (
    <div>
      <PageHeader title="Livraison" description="Expéditions, prestataires et taux de livraison réussie." />

      <LivraisonDateFilter initialRange={preset} initialFrom={params.dateFrom} initialTo={params.dateTo} />

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
          {showManifestTab && (
            <TabsTrigger value="bons-livraison">Bons de livraison ({manifestableShipments.length})</TabsTrigger>
          )}
          <TabsTrigger value="prestataires">Prestataires</TabsTrigger>
          <TabsTrigger value="documentation">Documentation</TabsTrigger>
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
                          {displayOrderNumber(s.order)}
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
              <DataTablePagination
                page={page}
                pageSize={shipmentsPageSize}
                total={shipmentsTotal}
                basePath="/livraison"
                searchParams={{ range: params.range, dateFrom: params.dateFrom, dateTo: params.dateTo }}
              />
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
                            {displayOrderNumber(o)}
                          </Link>
                        </TableCell>
                        <TableCell>{o.customer.fullName}</TableCell>
                        <TableCell>{formatCurrency(o.total.toString(), o.currency)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(o.createdAt)}</TableCell>
                        <TableCell>
                          <CreateShipmentDialog orderId={o.id} providers={shipmentProviderOptions} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>
        )}

        {showManifestTab && (
          <TabsContent value="bons-livraison" className="space-y-8">
            <section className="space-y-3">
              <div>
                <h2 className="text-[15px] font-semibold">Regrouper des colis sur un bon de livraison</h2>
                <p className="text-sm text-muted-foreground">
                  Sélectionnez les colis « En attente » à remettre au transporteur, puis générez le bon
                  de livraison. Le bordereau et les étiquettes s&apos;ouvrent sur le portail du transporteur.
                </p>
              </div>
              <ManifestBuilder shipments={manifestableShipments} />
            </section>

            <section className="space-y-3">
              <h2 className="text-[15px] font-semibold">Bons de livraison</h2>
              {manifests.length === 0 ? (
                <EmptyState icon={FileText} title="Aucun bon de livraison pour le moment." />
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Référence</TableHead>
                        <TableHead>Prestataire</TableHead>
                        <TableHead>Colis</TableHead>
                        <TableHead>Statut</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Documents</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {manifests.map((m) => {
                        const documents = Array.isArray(m.documents)
                          ? (m.documents as { label: string; url: string }[])
                          : [];
                        return (
                          <TableRow key={m.id}>
                            <TableCell className="font-mono text-xs">{m.externalRef ?? "—"}</TableCell>
                            <TableCell className="text-muted-foreground">{m.provider.name}</TableCell>
                            <TableCell>{m._count.shipments || m.parcelCount}</TableCell>
                            <TableCell>
                              <StatusBadge status={m.status} labels={DELIVERY_MANIFEST_STATUS_LABELS} />
                            </TableCell>
                            <TableCell className="text-muted-foreground">{formatDateTime(m.createdAt)}</TableCell>
                            <TableCell>
                              {m.status === "ECHEC" ? (
                                <span className="text-xs text-destructive">{m.failedReason ?? "Échec"}</span>
                              ) : documents.length === 0 ? (
                                <span className="text-xs text-muted-foreground">—</span>
                              ) : (
                                <div className="flex flex-wrap gap-1.5">
                                  {documents.map((d) => (
                                    <Button
                                      key={d.url}
                                      variant="outline"
                                      size="xs"
                                      render={
                                        <a href={d.url} target="_blank" rel="noopener noreferrer" />
                                      }
                                    >
                                      <ExternalLink className="size-3" />
                                      {d.label}
                                    </Button>
                                  ))}
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
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
                              <>
                                <ProviderConnectionControls providerId={p.id} providerKey={p.providerKey} connectors={connectors} />
                                <CityMappingDialog providerId={p.id} providerName={p.name} />
                              </>
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

        <TabsContent value="documentation">
          <DeliveryDocs />
        </TabsContent>
      </Tabs>
    </div>
  );
}
