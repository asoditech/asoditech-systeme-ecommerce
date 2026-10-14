import Link from "next/link";
import { Radar, Truck, PackageCheck, PackageX, HelpCircle, ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { TableCard } from "@/components/ui/table";
import { FilterBar, StatChip } from "@/components/filter-bar";
import { DataTablePagination } from "@/components/data-table-pagination";
import { redirect } from "next/navigation";
import { PAGE_SIZE_OPTIONS, outOfRangeHref, parsePage, parsePageSize } from "@/lib/pagination";
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
import { getBusinessTimeZone } from "@/lib/time/business-zone";

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
    pageSize?: string;
  }>;
}) {
  const user = await requirePermission("delivery.view");
  const canManage = userHasPermission(user, "delivery.manage");
  const includeCosts = userHasPermission(user, "finance.view");
  const params = await searchParams;

  const page = parsePage(params.page);
  // « Afficher 10 | 50 | 100 par page » — only an allowed size is accepted (default 10).
  const pageSize = parsePageSize(params.pageSize);
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
  const { from: dateFrom, to: dateTo } = resolveDateRangePreset(rangePreset, new Date(), {}, await getBusinessTimeZone());

  const filters: TrackingFilters = {
    q: params.q?.trim() || undefined,
    status: statusFilter,
    providerId: params.provider || undefined,
    city: params.city || undefined,
    costSource: costSourceFilter,
    dateFrom,
    dateTo,
    page,
    pageSize,
  };
  const filterActive = Boolean(
    filters.q || filters.status || filters.providerId || filters.city || filters.costSource || params.range
  );

  const [{ rows, total }, stats, cities, providers] = await Promise.all([
    listTrackingRows(filters, { includeCosts }),
    getTrackingStats(),
    listTrackingCities(),
    listTrackingProviders(),
  ]);
  // Past the last page (e.g. the filtered set shrank) → the last page, same filters.
  const outOfRange = outOfRangeHref({ page, total, pageSize, basePath: "/livraison/suivi", searchParams: params });
  if (outOfRange) redirect(outOfRange);

  const inTransit =
    stats.byNormalized.PICKED_UP +
    stats.byNormalized.IN_TRANSIT +
    stats.byNormalized.AT_DEPOT +
    stats.byNormalized.OUT_FOR_DELIVERY;
  const pending = stats.byNormalized.CREATED + stats.byNormalized.PICKUP_PENDING;

  // Status shortcuts are filters: page 1, but the chosen page size is kept.
  const sizeSuffix = params.pageSize ? `&pageSize=${pageSize}` : "";
  // Compact statistics strip — same counts and links as before, one short row.
  const statItems = [
    { label: "Suivies", value: stats.total, icon: Truck, href: null, tone: "text-pill-peach-fg" },
    { label: "En transit", value: inTransit, icon: Radar, href: `/livraison/suivi?status=IN_TRANSIT${sizeSuffix}`, tone: "text-pill-blue-fg" },
    { label: "En attente de ramassage", value: pending, icon: PackageCheck, href: `/livraison/suivi?status=CREATED${sizeSuffix}`, tone: "text-pill-yellow-fg" },
    { label: "Livrées", value: stats.byNormalized.DELIVERED, icon: PackageCheck, href: `/livraison/suivi?status=DELIVERED${sizeSuffix}`, tone: "text-pill-green-fg" },
    { label: "Retours / échecs", value: stats.byNormalized.RETURNED + stats.byNormalized.FAILED, icon: PackageX, href: `/livraison/suivi?status=RETURNED${sizeSuffix}`, tone: "text-pill-red-fg" },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight text-ink">
          <Link href="/livraison" className="text-ink-muted transition-colors hover:text-ink">
            Livraison
          </Link>
          <ChevronRight className="size-4 text-ink-muted" aria-hidden="true" />
          Suivi
        </h1>
        {canManage && <RefreshTrackingButton mode="batch" />}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {statItems.map(({ label, value, icon, href, tone }) => (
          <StatChip key={label} icon={icon} iconClassName={tone} label={label} value={value} href={href} />
        ))}
      </div>

      <FilterBar>
        <FilterSearchInput
          paramKey="q"
          placeholder="N° commande, client, téléphone, n° de suivi, ville…"
          ariaLabel="Rechercher un colis par n° de commande, client, téléphone, n° de suivi ou ville"
          defaultValue={params.q}
          className="w-full sm:w-72"
        />
        <FilterSelect
          paramKey="status"
          value={params.status}
          allLabel="Tous les statuts"
          ariaLabel="Filtrer par statut de suivi"
          className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-48"
          options={NORMALIZED_STATUSES.map((s) => ({ value: s, label: NORMALIZED_TRACKING_LABELS[s] }))}
        />
        {providers.length > 1 && (
          <FilterSelect
            paramKey="provider"
            value={params.provider}
            allLabel="Tous les transporteurs"
            ariaLabel="Filtrer par transporteur"
            className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-48"
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
          />
        )}
        {cities.length > 0 && (
          <FilterSelect
            paramKey="city"
            value={params.city}
            allLabel="Toutes les villes"
            ariaLabel="Filtrer par ville"
            className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-44"
            options={cities.map((c) => ({ value: c, label: c }))}
          />
        )}
        {includeCosts && (
          <FilterSelect
            paramKey="costSource"
            value={params.costSource}
            allLabel="Toutes les sources de coût"
            ariaLabel="Filtrer par source de coût"
            className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-52"
            options={COST_SOURCES.map((c) => ({ value: c, label: SHIPMENT_COST_SOURCE_LABELS[c] }))}
          />
        )}
        <FilterSelect
          paramKey="range"
          value={params.range}
          allLabel="Créées : toute la période"
          ariaLabel="Filtrer par date de création de l'expédition"
          className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-44"
          options={RANGE_PRESETS.map((p) => ({ value: p, label: DATE_RANGE_PRESET_LABELS[p] }))}
        />
        {filterActive && (
          <Button variant="ghost" render={<Link href={params.pageSize ? `/livraison/suivi?pageSize=${pageSize}` : "/livraison/suivi"} />}>
            Réinitialiser
          </Button>
        )}
      </FilterBar>

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
        <TableCard className="sm:[&>[data-slot=table-container]]:max-h-[max(18rem,calc(100dvh-19rem))] sm:[&>[data-slot=table-container]]:overflow-y-auto">
          <TrackingTable rows={rows} />
          <DataTablePagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/livraison/suivi"
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            searchParams={{
              q: params.q,
              status: params.status,
              provider: params.provider,
              city: params.city,
              costSource: params.costSource,
              range: params.range,
            }}
          />
        </TableCard>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-muted">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Le statut « suivi » est normalisé à partir du statut interne et du libellé brut du transporteur. En cas
          d&apos;échec d&apos;appel transporteur, le dernier statut connu est conservé — jamais remplacé par « inconnu ».
        </span>
      </p>
    </div>
  );
}
