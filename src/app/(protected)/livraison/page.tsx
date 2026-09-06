import Link from "next/link";
import { Truck, Package2, PackageCheck, PackageX, Percent } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { KpiCard } from "@/components/kpi-card";
import type { ShipmentProviderOption } from "@/components/delivery/create-shipment-dialog";
import { ShipmentStatusSelect } from "@/components/delivery/shipment-status-select";
import { ProviderForm } from "@/components/delivery/provider-form";
import { ProviderConnectionStatus, ProviderConnectionControls } from "@/components/delivery/provider-connection";
import { CityMappingDialog } from "@/components/delivery/city-mapping-dialog";
import { ShipmentProviderControls } from "@/components/delivery/shipment-provider-controls";
import { RefreshStatusesButton } from "@/components/delivery/refresh-statuses-button";
import { RetryShipmentButton } from "@/components/delivery/retry-shipment-button";
import { BrandLogo, type BrandKey } from "@/components/brand-logo";
import { AwaitingShipmentTable } from "@/components/delivery/awaiting-shipment-table";
import { DeliveryDocs } from "@/components/delivery/delivery-docs";
import { LivraisonDateFilter } from "@/components/delivery/livraison-date-filter";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
} from "@/lib/queries/delivery";
import { deleteShippingProviderAction, deleteFailedShipmentAction } from "@/actions/delivery";
import { formatCurrency, formatDateTime, displayOrderNumber, formatPercent } from "@/lib/format";
import { SHIPMENT_STATUS_LABELS, SHIPPING_PROVIDER_TYPE_LABELS } from "@/lib/status-labels";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";
import { resolveDateRangePreset, DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";
import { buildParcelContentsSummary } from "@/lib/delivery";

export const metadata = { title: "Livraison — ASODITECH Gestion E-commerce" };

const TERMINAL_SHIPMENT_STATUSES = ["LIVRE", "ANNULE", "RETOURNE"];

/** Carrier connector key → its brand logo (public/brands/). */
const PROVIDER_BRANDS: Partial<Record<string, BrandKey>> = {
  ozonexpress: "ozonexpress",
  ameex: "ameex",
  speedaf: "speedaf",
};

export default async function LivraisonPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: string;
    tab?: string;
    aexp?: string;
    aexpq?: string;
  }>;
}) {
  const user = await requirePermission("delivery.view");
  const canManage = hasPermission(user.role, "delivery.manage");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const aexpPage = Number(params.aexp) || 1;
  const aexpSearch = params.aexpq?.trim() || undefined;
  const TABS = ["expeditions", "a-expedier", "prestataires", "documentation"];
  const activeTab = params.tab && TABS.includes(params.tab) ? params.tab : "expeditions";

  const rangeParam: DateRangePreset =
    params.range && params.range in DATE_RANGE_PRESET_LABELS ? (params.range as DateRangePreset) : "all";
  // Filling a date input alone is enough — no need to also switch the
  // dropdown to "Période personnalisée".
  const preset: DateRangePreset = params.dateFrom || params.dateTo ? "custom" : rangeParam;
  const { from: dateFrom, to: dateTo } = resolveDateRangePreset(preset, new Date(), {
    from: params.dateFrom,
    to: params.dateTo,
  });

  const [stats, providers, shipmentsResult, awaitingResult, connectors] = await Promise.all([
    getDeliveryStats(dateFrom, dateTo),
    listShippingProviders(),
    listShipments({ dateFrom, dateTo, page }),
    canManage
      ? listOrdersAwaitingShipment({ page: aexpPage, search: aexpSearch })
      : Promise.resolve({ orders: [], total: 0, page: 1, pageSize: 30 }),
    listAvailableDeliveryConnectors(),
  ]);
  const { shipments, total: shipmentsTotal, pageSize: shipmentsPageSize } = shipmentsResult;
  const {
    orders: awaitingShipment,
    total: awaitingTotal,
    pageSize: awaitingPageSize,
  } = awaitingResult;
  const hasApiShipments = shipments.some((s) => s.externalId);

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

  return (
    <div>
      <PageHeader
        title="Livraison"
        description="Expéditions, prestataires et taux de livraison réussie."
        actions={<LivraisonDateFilter initialRange={preset} initialFrom={params.dateFrom} initialTo={params.dateTo} />}
      />

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

      <Tabs defaultValue={activeTab}>
        <TabsList>
          <TabsTrigger value="expeditions">Expéditions &amp; suivi</TabsTrigger>
          {canManage && <TabsTrigger value="a-expedier">À expédier ({awaitingTotal})</TabsTrigger>}
          <TabsTrigger value="prestataires">Prestataires</TabsTrigger>
          <TabsTrigger value="documentation">Documentation</TabsTrigger>
        </TabsList>

        <TabsContent value="expeditions" className="space-y-3">
          {canManage && hasApiShipments && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                « Statut transporteur » = le statut brut renvoyé par le transporteur (Livré, Retourné…).
              </p>
              <RefreshStatusesButton />
            </div>
          )}
          {shipments.length === 0 ? (
            <EmptyState icon={Truck} title="Aucune expédition pour le moment." />
          ) : (
            <div className="rounded-lg border">
              <Table className="text-[13px] [&_td]:px-2.5 [&_td]:py-2 [&_th]:px-2.5">
                <TableHeader>
                  <TableRow>
                    <TableHead>Commande</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Suivi</TableHead>
                    <TableHead className="text-right">Frais</TableHead>
                    <TableHead className="text-right">COD</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Statut transporteur</TableHead>
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
                      <TableCell>
                        <span className="block max-w-[8rem] truncate">{s.order.customer.fullName}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <span className="block max-w-[9rem] truncate font-mono text-xs">
                          {s.trackingUrl ? (
                            <a href={s.trackingUrl} target="_blank" rel="noreferrer" className="hover:underline">
                              {s.trackingNumber ?? "Suivre"}
                            </a>
                          ) : (
                            (s.trackingNumber ?? "—")
                          )}
                        </span>
                        <span className="block text-[11px] text-muted-foreground/70">{s.provider.name}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {s.cost !== null ? formatCurrency(s.cost.toString(), s.order.currency) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {s.order.paymentMethod === "PAIEMENT_LIVRAISON"
                          ? formatCurrency(s.order.total.toString(), s.order.currency)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {canManage ? (
                          <ShipmentStatusSelect shipmentId={s.id} currentStatus={s.status as ShipmentStatusValue} />
                        ) : (
                          <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {s.providerStatusRaw ? (
                          <>
                            <span className="text-foreground">{s.providerStatusRaw}</span>
                            {s.lastSyncedAt && (
                              <span className="block text-[11px] text-muted-foreground/70">
                                {formatDateTime(s.lastSyncedAt)}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      {canManage && (
                        <TableCell>
                          {s.externalId ? (
                            <ShipmentProviderControls
                              shipmentId={s.id}
                              canCancel={!TERMINAL_SHIPMENT_STATUSES.includes(s.status)}
                            />
                          ) : s.status === "ECHEC" ? (
                            <div className="space-y-1">
                              {s.failedReason && (
                                <p className="max-w-[16rem] text-[11px] leading-tight text-destructive">{s.failedReason}</p>
                              )}
                              <div className="flex flex-wrap gap-1">
                                {s.provider.type === "API" && s.order.shippingCity && (
                                  <CityMappingDialog
                                    providerId={s.provider.id}
                                    providerName={s.provider.name}
                                    defaultLocalCity={s.order.shippingCity}
                                    triggerLabel="Corriger la ville"
                                    triggerVariant="ghost"
                                  />
                                )}
                                {s.provider.type === "API" && (
                                  <RetryShipmentButton orderId={s.orderId} providerId={s.provider.id} />
                                )}
                                <ConfirmActionButton
                                  label="Supprimer"
                                  variant="ghost"
                                  title="Supprimer cette tentative d'expédition ?"
                                  description="La ligne en échec est retirée. Aucun colis n'existe chez le transporteur. La commande reste inchangée et peut être ré-expédiée depuis « À expédier »."
                                  hiddenFields={{ shipmentId: s.id }}
                                  action={deleteFailedShipmentAction}
                                  successMessage="Tentative supprimée."
                                  destructive
                                />
                              </div>
                            </div>
                          ) : null}
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
          <TabsContent value="a-expedier" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Commandes prêtes, sans expédition — créez l&apos;expédition ici avant de marquer « Expédiée ».
            </p>
            <form className="flex flex-wrap gap-2" action="/livraison">
              <input type="hidden" name="tab" value="a-expedier" />
              <Input
                name="aexpq"
                placeholder="N° de commande ou nom du client…"
                defaultValue={params.aexpq}
                className="max-w-64"
              />
              <Button type="submit" variant="outline">
                Rechercher
              </Button>
              {aexpSearch && (
                <Button type="button" variant="ghost" render={<Link href="/livraison?tab=a-expedier" />}>
                  Réinitialiser
                </Button>
              )}
            </form>
            {awaitingShipment.length === 0 ? (
              <EmptyState
                icon={Package2}
                title={
                  aexpSearch
                    ? "Aucune commande à expédier ne correspond à cette recherche."
                    : "Aucune commande en attente d'expédition."
                }
              />
            ) : (
              <div className="space-y-2">
                <AwaitingShipmentTable
                  orders={awaitingShipment.map((o) => ({
                    id: o.id,
                    orderNumber: o.orderNumber,
                    source: o.source,
                    externalNumber: o.externalNumber,
                    customerName: o.customer.fullName,
                    total: o.total.toString(),
                    currency: o.currency,
                    placedAt: o.placedAt.toISOString(),
                    parcelContents: buildParcelContentsSummary(o.items) || null,
                  }))}
                  providers={shipmentProviderOptions}
                />
                <DataTablePagination
                  page={awaitingResult.page}
                  pageSize={awaitingPageSize}
                  total={awaitingTotal}
                  basePath="/livraison"
                  pageParam="aexp"
                  searchParams={{ tab: "a-expedier", aexpq: params.aexpq }}
                />
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
                      <TableCell className="font-medium">
                        <span className="flex items-center gap-2">
                          {p.providerKey && p.providerKey in PROVIDER_BRANDS && (
                            <BrandLogo
                              brand={PROVIDER_BRANDS[p.providerKey]!}
                              label={p.name}
                              className="size-5"
                            />
                          )}
                          {p.name}
                        </span>
                      </TableCell>
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
