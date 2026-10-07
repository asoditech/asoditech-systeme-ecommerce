import Link from "next/link";
import { Radar, Truck, PackageCheck, PackageX, HelpCircle, ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { TrackingTable } from "@/components/tracking/tracking-table";
import { RefreshTrackingButton } from "@/components/tracking/refresh-tracking-button";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
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
  const canManage = userHasPermission(user, "delivery.manage");
  const includeCosts = userHasPermission(user, "finance.view");
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

  // Compact statistics strip — same counts and links as before, one short row.
  const statItems = [
    { label: "Suivies", value: stats.total, icon: Truck, href: null, tone: "text-primary" },
    { label: "En transit", value: inTransit, icon: Radar, href: "/livraison/suivi?status=IN_TRANSIT", tone: "text-sky-600 dark:text-sky-400" },
    { label: "En attente de ramassage", value: pending, icon: PackageCheck, href: "/livraison/suivi?status=CREATED", tone: "text-amber-600 dark:text-amber-400" },
    { label: "Livrées", value: stats.byNormalized.DELIVERED, icon: PackageCheck, href: "/livraison/suivi?status=DELIVERED", tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Retours / échecs", value: stats.byNormalized.RETURNED + stats.byNormalized.FAILED, icon: PackageX, href: "/livraison/suivi?status=RETURNED", tone: "text-destructive" },
  ];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight">
          <Link href="/livraison" className="text-muted-foreground transition-colors hover:text-foreground">
            Livraison
          </Link>
          <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
          Suivi
        </h1>
        {canManage && <RefreshTrackingButton mode="batch" />}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {statItems.map(({ label, value, icon: Icon, href, tone }) => {
          const body = (
            <>
              <Icon className={`size-4 ${tone}`} aria-hidden="true" />
              <span className="text-muted-foreground">{label}</span>
              <span className="font-semibold tabular-nums">{value}</span>
            </>
          );
          const className = "inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm shadow-xs";
          return href ? (
            <Link key={label} href={href} className={`${className} transition-colors hover:bg-muted`}>
              {body}
            </Link>
          ) : (
            <div key={label} className={className}>
              {body}
            </div>
          );
        })}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
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
        // The table is the workspace: it takes the remaining viewport height
        // and scrolls inside (sticky header) — more rows visible at once.
        <div className="rounded-lg border bg-card sm:[&>[data-slot=table-container]]:max-h-[max(18rem,calc(100dvh-19rem))] sm:[&>[data-slot=table-container]]:overflow-y-auto">
          <TrackingTable rows={rows} />
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

      <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Le statut « suivi » est normalisé à partir du statut interne et du libellé brut du transporteur. En cas
          d&apos;échec d&apos;appel transporteur, le dernier statut connu est conservé — jamais remplacé par « inconnu ».
        </span>
      </p>
    </div>
  );
}
