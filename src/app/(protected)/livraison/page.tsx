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
import { ProviderPricingDialog } from "@/components/delivery/provider-pricing-dialog";
import { ShipmentProviderControls } from "@/components/delivery/shipment-provider-controls";
import { RefreshStatusesButton } from "@/components/delivery/refresh-statuses-button";
import { RetryShipmentButton } from "@/components/delivery/retry-shipment-button";
import { BrandLogo, type BrandKey } from "@/components/brand-logo";
import { AwaitingShipmentTable } from "@/components/delivery/awaiting-shipment-table";
import { shipmentCodAmount } from "@/lib/shipment-confirmation";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { DeliveryDocs } from "@/components/delivery/delivery-docs";
import { LivraisonDateFilter } from "@/components/delivery/livraison-date-filter";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DataTablePagination } from "@/components/data-table-pagination";
import { FilterBar } from "@/components/filter-bar";
import { redirect } from "next/navigation";
import { PAGE_SIZE_OPTIONS, buildListHref, clampPage, parsePage, parsePageSize } from "@/lib/pagination";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import {
  listShippingProviders,
  listShipments,
  getDeliveryStats,
  listOrdersAwaitingShipment,
  listAvailableDeliveryConnectors,
  providerCapabilities,
} from "@/lib/queries/delivery";
import { deleteShippingProviderAction, deleteFailedShipmentAction } from "@/actions/delivery";
import { formatCurrency, formatDateTime, displayOrderNumber, displayOrderRecipient, formatPercent } from "@/lib/format";
import { SHIPMENT_STATUS_LABELS, SHIPPING_PROVIDER_TYPE_LABELS } from "@/lib/status-labels";
import { canCancelCarrierShipment, type ShipmentStatusValue } from "@/lib/validation/delivery";
import { resolveDateRangePreset, DATE_RANGE_PRESET_LABELS, type DateRangePreset } from "@/lib/date-range-presets";
import { buildParcelContentsSummary } from "@/lib/delivery";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { getBusinessTimeZone } from "@/lib/time/business-zone";

export const metadata = { title: "Livraison — ASODITECH Gestion E-commerce" };

/** Carrier connector key → its brand logo (public/brands/). */
const PROVIDER_BRANDS: Partial<Record<string, BrandKey>> = {
  ozonexpress: "ozonexpress",
  aramex: "aramex",
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
    pageSize?: string;
    tab?: string;
    aexp?: string;
    aexpPageSize?: string;
    aexpq?: string;
    sstatus?: string;
    sprovider?: string;
    sq?: string;
    shist?: string;
  }>;
}) {
  const user = await requirePermission("delivery.view");
  const canManage = userHasPermission(user, "delivery.manage");
  const params = await searchParams;
  // Two independent tables, two cursors: « Expéditions » = page/pageSize,
  // « À expédier » = aexp/aexpPageSize (10/50/100, default 10).
  const page = parsePage(params.page);
  const aexpPage = parsePage(params.aexp);
  const shipmentsSize = parsePageSize(params.pageSize);
  const awaitingSize = parsePageSize(params.aexpPageSize);
  // The chosen sizes survive every filter change (the cursors reset to 1).
  const sizeParams = {
    pageSize: params.pageSize ? String(shipmentsSize) : undefined,
    aexpPageSize: params.aexpPageSize ? String(awaitingSize) : undefined,
  };
  const aexpSearch = params.aexpq?.trim() || undefined;
  const TABS = ["expeditions", "a-expedier", "prestataires", "documentation"];
  const activeTab = params.tab && TABS.includes(params.tab) ? params.tab : "expeditions";

  const rangeParam: DateRangePreset =
    params.range && params.range in DATE_RANGE_PRESET_LABELS ? (params.range as DateRangePreset) : "all";
  // Filling a date input alone is enough — no need to also switch the
  // dropdown to "Période personnalisée".
  const preset: DateRangePreset = params.dateFrom || params.dateTo ? "custom" : rangeParam;
  const { from: dateFrom, to: dateTo } = resolveDateRangePreset(
    preset,
    new Date(),
    { from: params.dateFrom, to: params.dateTo },
    await getBusinessTimeZone()
  );

  const SHIPMENT_STATUSES = ["EN_ATTENTE", "EN_TRANSIT", "LIVRE", "ECHEC", "RETOURNE", "ANNULE"] as const;
  const shipmentStatusFilter = SHIPMENT_STATUSES.includes(params.sstatus as (typeof SHIPMENT_STATUSES)[number])
    ? (params.sstatus as (typeof SHIPMENT_STATUSES)[number])
    : undefined;
  const shipmentSearch = params.sq?.trim() || undefined;
  const shipmentFilterActive = Boolean(shipmentStatusFilter || params.sprovider || shipmentSearch);
  // Default: one row per order (its current shipment); « shist=1 » adds the
  // replaced attempts, labelled « Remplacée ».
  const showHistory = params.shist === "1";
  const historyToggleHref = (() => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ range: params.range, dateFrom: params.dateFrom, dateTo: params.dateTo, sstatus: params.sstatus, sprovider: params.sprovider, sq: params.sq, ...sizeParams })) {
      if (v) sp.set(k, v);
    }
    if (!showHistory) sp.set("shist", "1");
    const qs = sp.toString();
    return qs ? `/livraison?${qs}` : "/livraison";
  })();

  // Read once: the shipment search reuses the tenant's order-number prefix.
  const businessPromise = getReportBusinessInfo();
  const [stats, providers, shipmentsResult, awaitingResult, connectors, business] = await Promise.all([
    getDeliveryStats(dateFrom, dateTo),
    listShippingProviders(),
    businessPromise.then((b) =>
      listShipments({
        dateFrom,
        dateTo,
        page,
        pageSize: shipmentsSize,
        status: shipmentStatusFilter,
        providerId: params.sprovider || undefined,
        search: shipmentSearch,
        orderNumberPrefix: b.orderNumberPrefix,
        history: showHistory,
      })
    ),
    canManage
      ? listOrdersAwaitingShipment({ page: aexpPage, search: aexpSearch, pageSize: awaitingSize })
      : Promise.resolve({ orders: [], total: 0, page: 1, pageSize: awaitingSize }),
    listAvailableDeliveryConnectors(),
    businessPromise,
  ]);
  const { shipments, total: shipmentsTotal, pageSize: shipmentsPageSize, previousAttemptsByOrder, supersededIds } = shipmentsResult;
  const replaced = new Set(supersededIds);
  const {
    orders: awaitingShipment,
    total: awaitingTotal,
    pageSize: awaitingPageSize,
  } = awaitingResult;
  // Either cursor past its last page (e.g. the last row of the last page was
  // just shipped/deleted) → back to that table's last page, all else kept.
  const shipmentsLast = clampPage(page, shipmentsTotal, shipmentsPageSize);
  const awaitingLast = clampPage(aexpPage, awaitingTotal, awaitingPageSize);
  if ((shipmentsTotal > 0 && page > shipmentsLast) || (awaitingTotal > 0 && aexpPage > awaitingLast)) {
    redirect(
      buildListHref("/livraison", params, {
        ...(shipmentsTotal > 0 && page > shipmentsLast ? { page: shipmentsLast } : {}),
        ...(awaitingTotal > 0 && aexpPage > awaitingLast ? { aexp: awaitingLast } : {}),
      })
    );
  }
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
    capabilities: providerCapabilities(p),
  }));

  return (
    <div>
      <PageHeader
        title="Livraison"
        description="Expéditions, prestataires et taux de livraison réussie."
        actions={<LivraisonDateFilter initialRange={preset} initialFrom={params.dateFrom} initialTo={params.dateTo} keepParams={sizeParams} />}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Commandes expédiées"
          value={String(stats.total)}
          hint="Une par commande (sa dernière expédition) — les tentatives remplacées n'y sont pas recomptées."
          icon={Truck}
          tone="primary"
          info="ordersShipped"
        />
        <KpiCard label="Livrées" value={String(stats.delivered)} icon={PackageCheck} tone="success" />
        <KpiCard
          label="Échecs"
          value={String(stats.failed)}
          hint={stats.returned > 0 ? `+ ${stats.returned} retournée(s)` : undefined}
          icon={PackageX}
          tone="danger"
        />
        <KpiCard
          label="Taux de livraison réussie"
          value={stats.successRate !== null ? formatPercent(stats.successRate) : null}
          hint="Livrées ÷ (livrées + échecs + retours)"
          unavailableReason="Aucune livraison terminée"
          icon={Percent}
          tone="info"
          info="deliveryRate"
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

          {(shipments.length > 0 || shipmentFilterActive) && (
            <FilterBar className="mb-2">
              <FilterSearchInput
                paramKey="sq"
                placeholder="N° commande, client, téléphone, n° de suivi…"
                ariaLabel="Rechercher une expédition par n° de commande, client, téléphone ou n° de suivi"
                defaultValue={params.sq}
                className="w-full sm:w-72"
              />
              <FilterSelect
                paramKey="sstatus"
                value={shipmentStatusFilter}
                allLabel="Tous les statuts"
                ariaLabel="Filtrer par statut"
                className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-44"
                options={SHIPMENT_STATUSES.map((s) => ({ value: s, label: SHIPMENT_STATUS_LABELS[s].label }))}
              />
              {providers.length > 1 && (
                <FilterSelect
                  paramKey="sprovider"
                  value={params.sprovider}
                  allLabel="Tous les transporteurs"
                  ariaLabel="Filtrer par transporteur"
                  className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-52"
                  options={providers.map((p) => ({ value: p.id, label: p.name }))}
                />
              )}
              <Button variant="ghost" render={<Link href={historyToggleHref} />} aria-pressed={showHistory}>
                {showHistory ? "Masquer les tentatives remplacées" : "Afficher l'historique des tentatives"}
              </Button>
            </FilterBar>
          )}

          {shipments.length === 0 ? (
            <EmptyState
              icon={Truck}
              title={
                shipmentFilterActive
                  ? "Aucune expédition ne correspond à ces filtres."
                  : "Aucune expédition pour le moment."
              }
            />
          ) : (
            <TableCard>
              <Table className="text-[13px] [&_td]:px-2.5 [&_th]:px-2.5">
                <TableHeader>
                  <TableRow>
                    <TableHead>Commande</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Suivi</TableHead>
                    <TableHead className="text-right">Montant commande</TableHead>
                    <TableHead className="text-right">Frais</TableHead>
                    <TableHead className="text-right">COD</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Statut transporteur</TableHead>
                    {canManage && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shipments.map((s) => (
                    <TableRow key={s.id} className={replaced.has(s.id) ? "opacity-60" : undefined}>
                      <TableCell>
                        <Link href={`/commandes/${s.orderId}`} className="text-[15px] font-semibold tracking-tight text-ink hover:underline">
                          {displayOrderNumber(s.order, business.orderNumberPrefix)}
                        </Link>
                        {replaced.has(s.id) ? (
                          <Badge variant="outline" className="ml-1 text-xs" title="Une expédition plus récente a remplacé celle-ci pour la même commande.">
                            Remplacée
                          </Badge>
                        ) : !showHistory && previousAttemptsByOrder[s.orderId] ? (
                          <Link
                            href={`/commandes/${s.orderId}`}
                            className="mt-0.5 block text-xs text-ink-muted hover:underline"
                            title="Voir les expéditions précédentes de cette commande"
                          >
                            + {previousAttemptsByOrder[s.orderId]} tentative{previousAttemptsByOrder[s.orderId] > 1 ? "s" : ""} précédente
                            {previousAttemptsByOrder[s.orderId] > 1 ? "s" : ""}
                          </Link>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-[10rem] truncate font-medium text-ink">{displayOrderRecipient(s.order)}</span>
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
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-ink-muted">
                          {s.provider.providerKey && s.provider.providerKey in PROVIDER_BRANDS ? (
                            <BrandLogo
                              brand={PROVIDER_BRANDS[s.provider.providerKey]!}
                              label={s.provider.name}
                              className="size-3.5"
                            />
                          ) : (
                            s.provider.name
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(s.order.total.toString(), s.order.currency)}
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
                          <ShipmentStatusSelect
                            shipmentId={s.id}
                            currentStatus={s.status as ShipmentStatusValue}
                            carrierParcel={s.provider.type === "API" && s.externalId !== null}
                          />
                        ) : (
                          <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {s.providerStatusRaw ? (
                          <>
                            <span className="text-foreground">{s.providerStatusRaw}</span>
                            {s.lastSyncedAt && (
                              <span className="block text-xs text-ink-muted">
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
                              providerName={s.provider.name}
                              canCancel={canCancelCarrierShipment(
                                s.status as ShipmentStatusValue,
                                providerCapabilities(s.provider).includes("CANCEL_SHIPMENT")
                              )}
                            />
                          ) : s.status === "ECHEC" ? (
                            <div className="space-y-1">
                              {s.failedReason && (
                                <p className="max-w-[16rem] text-xs leading-tight text-destructive">{s.failedReason}</p>
                              )}
                              <div className="flex flex-wrap gap-1">
                                {s.provider.type === "API" &&
                                  providerCapabilities(s.provider).includes("FETCH_CITIES") &&
                                  s.order.shippingCity && (
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
                                {s.provider.type === "API" && (
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
                                )}
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
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                pageSizeParam="pageSize"
                searchParams={{
                  range: params.range,
                  dateFrom: params.dateFrom,
                  dateTo: params.dateTo,
                  sstatus: params.sstatus,
                  sprovider: params.sprovider,
                  sq: params.sq,
                  shist: params.shist,
                  // The « À expédier » table's own cursor/search/size are kept.
                  aexp: params.aexp,
                  aexpq: params.aexpq,
                  aexpPageSize: sizeParams.aexpPageSize,
                }}
              />
            </TableCard>
          )}
        </TabsContent>

        {canManage && (
          <TabsContent value="a-expedier" className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Commandes prêtes, sans expédition — créez l&apos;expédition ici avant de marquer « Expédiée ».
            </p>
            <form className="flex flex-wrap items-center gap-2" action="/livraison">
              <input type="hidden" name="tab" value="a-expedier" />
              {sizeParams.aexpPageSize ? <input type="hidden" name="aexpPageSize" value={sizeParams.aexpPageSize} /> : null}
              {sizeParams.pageSize ? <input type="hidden" name="pageSize" value={sizeParams.pageSize} /> : null}
              <Input
                name="aexpq"
                placeholder="N° commande, client, téléphone, n° de suivi…"
                aria-label="Rechercher une commande à expédier par n° de commande, client, téléphone ou n° de suivi"
                defaultValue={params.aexpq}
                className="w-full sm:w-72"
              />
              <Button type="submit" variant="outline">
                Rechercher
              </Button>
              {aexpSearch && (
                <Button type="button" variant="ghost" render={<Link href={buildListHref("/livraison", { tab: "a-expedier", ...sizeParams })} />}>
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
                    displayNumber: o.displayNumber,
                    source: o.source,
                    externalNumber: o.externalNumber,
                    customerName: displayOrderRecipient(o),
                    total: o.total.toString(),
                    currency: o.currency,
                    placedAt: o.placedAt.toISOString(),
                    parcelContents: buildParcelContentsSummary(o.items) || null,
                    failedReason: o.shipments[0]?.failedReason ?? null,
                    codAmount: shipmentCodAmount(o.paymentMethod, o.total.toString()),
                    lineCount: o.items.length,
                    address: {
                      shippingAddressLine1: o.shippingAddressLine1,
                      shippingAddressLine2: o.shippingAddressLine2,
                      shippingCity: o.shippingCity,
                      shippingRegion: o.shippingRegion,
                      shippingCountry: o.shippingCountry,
                      shippingPhone: o.shippingPhone,
                    },
                  }))}
                  providers={shipmentProviderOptions}
                  orderNumberPrefix={business.orderNumberPrefix}
                />
                <DataTablePagination
                  page={awaitingResult.page}
                  pageSize={awaitingPageSize}
                  total={awaitingTotal}
                  basePath="/livraison"
                  pageParam="aexp"
                  pageSizeOptions={PAGE_SIZE_OPTIONS}
                  pageSizeParam="aexpPageSize"
                  searchParams={{
                    tab: "a-expedier",
                    aexpq: params.aexpq,
                    // The « Expéditions » table's filters/cursor/size are kept.
                    range: params.range,
                    dateFrom: params.dateFrom,
                    dateTo: params.dateTo,
                    sstatus: params.sstatus,
                    sprovider: params.sprovider,
                    sq: params.sq,
                    shist: params.shist,
                    page: params.page,
                    pageSize: sizeParams.pageSize,
                  }}
                />
              </div>
            )}
          </TabsContent>
        )}

        <TabsContent value="prestataires" className="space-y-4">
          {providers.length === 0 ? (
            <EmptyState icon={Truck} title="Aucun prestataire de livraison configuré." />
          ) : (
            <TableCard>
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
                      <TableCell className="font-medium text-ink">
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
                                {providerCapabilities(p).includes("FETCH_CITIES") && (
                                  <CityMappingDialog providerId={p.id} providerName={p.name} />
                                )}
                              </>
                            )}
                            <ProviderPricingDialog
                              providerId={p.id}
                              providerName={p.name}
                              isApiProvider={p.type === "API"}
                              returnCost={p.returnCost?.toString() ?? null}
                              failureCost={p.failureCost?.toString() ?? null}
                            />
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
            </TableCard>
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
