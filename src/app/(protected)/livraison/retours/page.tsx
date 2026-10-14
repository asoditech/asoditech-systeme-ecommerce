import Link from "next/link";
import { ChevronRight, HelpCircle, PackageCheck, PackageOpen, PackageSearch, Undo2 } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { FilterBar, StatChip } from "@/components/filter-bar";
import { TableCard } from "@/components/ui/table";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { ReturnsScanLot } from "@/components/returns/returns-workspace";
import { ReturnParcelsTable } from "@/components/returns/return-parcels-table";
import { requirePermission } from "@/lib/auth/guards";
import { formatDateTime } from "@/lib/format";
import {
  listReturnParcels,
  RETURN_PARCEL_STATE_LABELS,
  type ReturnParcelState,
} from "@/lib/queries/return-receiving";

export const metadata = { title: "Retours colis — ASODITECH Gestion E-commerce" };

const STATES = Object.keys(RETURN_PARCEL_STATE_LABELS) as ReturnParcelState[];

/**
 * P3 — returns receiving workspace. Lists ONLY parcels the carrier reports
 * « Retourné » (Shipment.status RETOURNE), within the user's locations, by
 * physical stage: to receive → received / to inspect → inspected. Nothing on
 * this page calls a carrier or changes an order / shipment status (the order
 * already moved to RETOUR with its parcel — docs/adr/0006, 2026-10-12).
 */
export default async function RetoursColisPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; state?: string; page?: string }>;
}) {
  const user = await requirePermission("orders.return");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const state = STATES.includes(params.state as ReturnParcelState) ? (params.state as ReturnParcelState) : undefined;
  const q = params.q?.trim() || undefined;
  const filterActive = Boolean(q || state);

  const { rows, total, pageSize, counts } = await listReturnParcels(user, { q, state, page });
  const receptionText = Object.fromEntries(
    rows.map((p) => [
      p.shipmentId,
      p.pendingReception
        ? `${formatDateTime(p.pendingReception.receivedAt)}${p.pendingReception.receivedByName ? ` · ${p.pendingReception.receivedByName}` : ""}`
        : p.lastInspection?.inspectedAt
          ? `Inspecté le ${formatDateTime(p.lastInspection.inspectedAt)}${p.lastInspection.inspectedByName ? ` · ${p.lastInspection.inspectedByName}` : ""}`
          : "—",
    ])
  );

  const statItems = [
    { key: "A_RECEPTIONNER" as const, icon: PackageSearch, tone: "text-pill-yellow-fg" },
    { key: "A_INSPECTER" as const, icon: PackageOpen, tone: "text-pill-blue-fg" },
    { key: "INSPECTE" as const, icon: PackageCheck, tone: "text-pill-green-fg" },
    // Every unit already recorded as returned elsewhere (e.g. the order page) — history, not work.
    { key: "DEJA_RETOURNE" as const, icon: Undo2, tone: "text-ink-muted" },
  ];

  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight text-ink">
        <Link href="/livraison" className="text-ink-muted transition-colors hover:text-ink">
          Livraison
        </Link>
        <ChevronRight className="size-4 text-ink-muted" aria-hidden="true" />
        Retours colis
      </h1>

      <div className="flex flex-wrap gap-2">
        {statItems.map(({ key, icon: Icon, tone }) => (
          <StatChip
            key={key}
            href={`/livraison/retours?state=${key}`}
            icon={Icon}
            iconClassName={tone}
            label={RETURN_PARCEL_STATE_LABELS[key]}
            value={counts[key]}
          />
        ))}
      </div>

      <ReturnsScanLot />

      <FilterBar className="mb-0">
        <FilterSearchInput paramKey="q" placeholder="N° de suivi, commande, client, téléphone…" defaultValue={params.q} className="w-full sm:w-72" />
        <FilterSelect
          paramKey="state"
          value={params.state}
          allLabel="Toutes les étapes"
          ariaLabel="Filtrer par étape"
          className="w-[calc(50%-0.25rem)] sm:w-auto sm:min-w-48"
          options={STATES.map((s) => ({ value: s, label: RETURN_PARCEL_STATE_LABELS[s] }))}
        />
        {filterActive && (
          <Button variant="ghost" render={<Link href="/livraison/retours" />}>
            Réinitialiser
          </Button>
        )}
      </FilterBar>

      {rows.length === 0 ? (
        <EmptyState
          icon={Undo2}
          title={filterActive ? "Aucun colis retourné ne correspond à ces filtres." : "Aucun colis au statut « Retourné » pour le moment."}
        />
      ) : (
        <TableCard>
          <ReturnParcelsTable rows={rows} receptionText={receptionText} />
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/livraison/retours" searchParams={{ q: params.q, state: params.state }} />
        </TableCard>
      )}

      <p className="flex items-start gap-1.5 text-xs text-ink-muted">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Seuls les colis que le transporteur indique « Retourné » apparaissent ici (la commande passe alors en « Retour »).
          Scanner un colis ou un n° de commande sert seulement à l&apos;identifier et l&apos;ajouter au lot : rien n&apos;est
          réceptionné sans confirmation. Les articles sont identifiés un par un à l&apos;inspection. Réceptionner ne modifie
          pas le stock : seules les unités jugées revendables à l&apos;inspection reviennent en stock disponible, à leur
          emplacement d&apos;origine, une seule fois. L&apos;inspection se fait colis par colis (un état par unité).
        </span>
      </p>
    </div>
  );
}
