import Link from "next/link";
import { Radar, Truck, PackageCheck, PackageX, HelpCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrackingStatusBadge } from "@/components/tracking/tracking-status-badge";
import { RefreshTrackingButton } from "@/components/tracking/refresh-tracking-button";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import {
  listTrackingRows,
  getTrackingStats,
  listTrackingCities,
  listTrackingProviders,
  type TrackingFilters,
} from "@/lib/queries/tracking";
import {
  NORMALIZED_TRACKING_LABELS,
  type NormalizedTrackingStatus,
} from "@/lib/tracking/status";
import { SHIPMENT_COST_SOURCE_LABELS } from "@/lib/status-labels";
import { formatCurrency, formatDateTime } from "@/lib/format";
import {
  resolveDateRangePreset,
  DATE_RANGE_PRESET_LABELS,
  type DateRangePreset,
} from "@/lib/date-range-presets";

export const metadata = { title: "Suivi des expéditions — ASODITECH Gestion E-commerce" };

const NORMALIZED_STATUSES = Object.keys(NORMALIZED_TRACKING_LABELS) as NormalizedTrackingStatus[];
const COST_SOURCES = ["CARRIER_API", "RETURN_RULE", "FAILURE_RULE", "MANUAL_OVERRIDE"] as const;
// Preset date filter only — a shipment's tracking is a "now" question, the
// standard presets cover it and keep the URL simple.
const RANGE_PRESETS: DateRangePreset[] = ["today", "yesterday", "7d", "30d", "90d", "this-month", "last-month"];

export default async function SuiviPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    provider?: string;
    city?: string;
    costSource?: string;
    range?: string;
    page?: string;
  }>;
}) {
  const user = await requirePermission("delivery.view");
  const canManage = hasPermission(user.role, "delivery.manage");
  const includeCosts = hasPermission(user.role, "finance.view");
  const params = await searchParams;

  const page = Number(params.page) || 1;
  const statusFilter = NORMALIZED_STATUSES.includes(params.status as NormalizedTrackingStatus)
    ? (params.status as NormalizedTrackingStatus)
    : undefined;
  const costSourceFilter = COST_SOURCES.includes(params.costSource as (typeof COST_SOURCES)[number])
    ? (params.costSource as (typeof COST_SOURCES)[number])
    : undefined;
  const rangePreset: DateRangePreset =
    params.range && RANGE_PRESETS.includes(params.range as DateRangePreset)
      ? (params.range as DateRangePreset)
      : "all";
  const { from: dateFrom, to: dateTo } = resolveDateRangePreset(rangePreset, new Date(), {});

  const filters: TrackingFilters = {
    q: params.q?.trim() || undefined,
    status: statusFilter,
    providerId: params.provider || undefined,
    city: params.city || undefined,
    costSource: costSourceFilter,
    dateFrom,
    dateTo,
    page,
  };
  const filterActive = Boolean(
    filters.q || filters.status || filters.providerId || filters.city || filters.costSource || params.range
  );

  const [{ rows, total, pageSize }, stats, cities, providers] = await Promise.all([
    listTrackingRows(filters, { includeCosts }),
    getTrackingStats(),
    listTrackingCities(),
    listTrackingProviders(),
  ]);

  const inTransit =
    stats.byNormalized.PICKED_UP +
    stats.byNormalized.IN_TRANSIT +
    stats.byNormalized.AT_DEPOT +
    stats.byNormalized.OUT_FOR_DELIVERY;
  const pending = stats.byNormalized.CREATED + stats.byNormalized.PICKUP_PENDING;

  return (
    <div>
      <PageHeader
        title="Suivi des expéditions"
        description="Vue centralisée du parcours de chaque colis chez le transporteur. N'altère jamais le module Livraison."
        breadcrumbs={[{ label: "Livraison", href: "/livraison" }, { label: "Suivi" }]}
        actions={canManage ? <RefreshTrackingButton mode="batch" /> : undefined}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Expéditions suivies" value={String(stats.total)} icon={Truck} tone="primary" />
        <Link href="/livraison/suivi?status=IN_TRANSIT" className="block">
          <KpiCard label="En transit" value={String(inTransit)} icon={Radar} tone="info" />
        </Link>
        <Link href="/livraison/suivi?status=CREATED" className="block">
          <KpiCard label="En attente de ramassage" value={String(pending)} icon={PackageCheck} tone="warning" />
        </Link>
        <Link href="/livraison/suivi?status=DELIVERED" className="block">
          <KpiCard label="Livrées" value={String(stats.byNormalized.DELIVERED)} icon={PackageCheck} tone="success" />
        </Link>
        <Link href="/livraison/suivi?status=RETURNED" className="block">
          <KpiCard
            label="Retours / échecs"
            value={String(stats.byNormalized.RETURNED + stats.byNormalized.FAILED)}
            icon={PackageX}
            tone="danger"
          />
        </Link>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <FilterSearchInput
          paramKey="q"
          placeholder="N° commande, client, téléphone, n° de suivi, ville…"
          defaultValue={params.q}
          className="w-72 max-w-full"
        />
        <FilterSelect
          paramKey="status"
          value={params.status}
          allLabel="Tous les statuts"
          ariaLabel="Filtrer par statut de suivi"
          className="w-48"
          options={NORMALIZED_STATUSES.map((s) => ({ value: s, label: NORMALIZED_TRACKING_LABELS[s] }))}
        />
        {providers.length > 1 && (
          <FilterSelect
            paramKey="provider"
            value={params.provider}
            allLabel="Tous les transporteurs"
            ariaLabel="Filtrer par transporteur"
            className="w-48"
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
          />
        )}
        {cities.length > 0 && (
          <FilterSelect
            paramKey="city"
            value={params.city}
            allLabel="Toutes les villes"
            ariaLabel="Filtrer par ville"
            className="w-44"
            options={cities.map((c) => ({ value: c, label: c }))}
          />
        )}
        {includeCosts && (
          <FilterSelect
            paramKey="costSource"
            value={params.costSource}
            allLabel="Toutes les sources de coût"
            ariaLabel="Filtrer par source de coût"
            className="w-52"
            options={COST_SOURCES.map((c) => ({ value: c, label: SHIPMENT_COST_SOURCE_LABELS[c] }))}
          />
        )}
        <FilterSelect
          paramKey="range"
          value={params.range}
          allLabel="Toute la période"
          ariaLabel="Filtrer par période"
          className="w-44"
          options={RANGE_PRESETS.map((p) => ({ value: p, label: DATE_RANGE_PRESET_LABELS[p] }))}
        />
        {filterActive && (
          <Button variant="ghost" size="sm" render={<Link href="/livraison/suivi" />}>
            Réinitialiser
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Radar}
          title={
            filterActive
              ? "Aucune expédition ne correspond à ces filtres."
              : "Aucune expédition à suivre pour le moment."
          }
        />
      ) : (
        <div className="rounded-lg border">
          <div className="overflow-x-auto">
            <Table className="text-[13px] [&_td]:px-2.5 [&_td]:py-2 [&_th]:px-2.5">
              <TableHeader>
                <TableRow>
                  <TableHead>Commande</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Ville</TableHead>
                  <TableHead className="text-right">Montant commande</TableHead>
                  <TableHead>Transporteur</TableHead>
                  <TableHead>N° de suivi</TableHead>
                  <TableHead>Statut suivi</TableHead>
                  <TableHead>Dernier évènement</TableHead>
                  {includeCosts && <TableHead className="text-right">Frais transporteur</TableHead>}
                  <TableHead>Dernière synchro</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  // The parcel's own recorded charge, by outcome — a
                  // delivered parcel carries a delivery fee, a RETOUR /
                  // ECHEC one its return / failure charge (docs/adr/0032).
                  // Kept as one column so the order amount beside it is
                  // never mistaken for a delivery cost (client feedback #7).
                  const feeSource =
                    r.costSource === "RETURN_RULE"
                      ? { amount: r.returnCost, label: "Frais de retour" }
                      : r.costSource === "FAILURE_RULE"
                        ? { amount: r.failureCost, label: "Frais d'échec" }
                        : { amount: r.deliveryCost, label: null as string | null };
                  return (
                    <TableRow key={r.shipmentId}>
                      <TableCell className="font-medium">
                        <Link href={`/livraison/suivi/${r.shipmentId}`} className="hover:underline">
                          {r.orderLabel}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-[9rem] truncate">{r.customerName}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.city ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(r.orderTotal, r.currency)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.providerName}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.trackingUrl ? (
                          <a href={r.trackingUrl} target="_blank" rel="noreferrer" className="hover:underline">
                            {r.trackingNumber ?? "Suivre"}
                          </a>
                        ) : (
                          (r.trackingNumber ?? "—")
                        )}
                      </TableCell>
                      <TableCell>
                        <TrackingStatusBadge status={r.normalizedStatus} raw={r.providerStatusRaw} showRaw />
                      </TableCell>
                      <TableCell className="max-w-[13rem] text-xs text-muted-foreground">
                        {r.trackingSyncError ? (
                          <span className="text-amber-600 dark:text-amber-400">
                            Dernière synchro en échec — dernier statut connu conservé
                          </span>
                        ) : r.latestEvent ? (
                          <>
                            <span className="block truncate text-foreground">{r.latestEvent.label}</span>
                            <span className="block text-[11px] text-muted-foreground/70">
                              {r.latestEvent.timestamp ? formatDateTime(r.latestEvent.timestamp) : "—"}
                              {r.latestEvent.location ? ` · ${r.latestEvent.location}` : ""}
                            </span>
                          </>
                        ) : (
                          "Aucun historique détaillé"
                        )}
                      </TableCell>
                      {includeCosts && (
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {feeSource.amount !== null ? formatCurrency(feeSource.amount, r.currency) : "—"}
                          {feeSource.label && (
                            <span className="block text-[11px] text-muted-foreground/70">{feeSource.label}</span>
                          )}
                        </TableCell>
                      )}
                      <TableCell className="text-xs text-muted-foreground/70">
                        {r.lastTrackingSyncAt ? formatDateTime(r.lastTrackingSyncAt) : "Jamais"}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" render={<Link href={`/livraison/suivi/${r.shipmentId}`} />}>
                          Détails
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/livraison/suivi"
            searchParams={{
              q: params.q,
              status: params.status,
              provider: params.provider,
              city: params.city,
              costSource: params.costSource,
              range: params.range,
            }}
          />
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Le statut « suivi » est normalisé à partir du statut interne et du libellé brut du transporteur. En cas
          d&apos;échec d&apos;appel transporteur, le dernier statut connu est conservé — jamais remplacé par « inconnu ».
        </span>
      </p>
    </div>
  );
}
