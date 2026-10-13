import Link from "next/link";
import { ChevronRight, HelpCircle, PackageCheck, PackageOpen, PackageSearch, Undo2 } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
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
    { key: "A_RECEPTIONNER" as const, icon: PackageSearch, tone: "text-amber-600 dark:text-amber-400" },
    { key: "A_INSPECTER" as const, icon: PackageOpen, tone: "text-sky-600 dark:text-sky-400" },
    { key: "INSPECTE" as const, icon: PackageCheck, tone: "text-emerald-600 dark:text-emerald-400" },
    // Every unit already recorded as returned elsewhere (e.g. the order page) — history, not work.
    { key: "DEJA_RETOURNE" as const, icon: Undo2, tone: "text-muted-foreground" },
  ];

  return (
    <div className="space-y-3">
      <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight">
        <Link href="/livraison" className="text-muted-foreground transition-colors hover:text-foreground">
          Livraison
        </Link>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
        Retours colis
      </h1>

      <div className="flex flex-wrap gap-2">
        {statItems.map(({ key, icon: Icon, tone }) => (
          <Link
            key={key}
            href={`/livraison/retours?state=${key}`}
            className="inline-flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-sm shadow-xs transition-colors hover:bg-muted"
          >
            <Icon className={`size-4 ${tone}`} aria-hidden="true" />
            <span className="text-muted-foreground">{RETURN_PARCEL_STATE_LABELS[key]}</span>
            <span className="font-semibold tabular-nums">{counts[key]}</span>
          </Link>
        ))}
      </div>

      <ReturnsScanLot />

      <div className="flex flex-wrap items-center gap-2">
        <FilterSearchInput paramKey="q" placeholder="N° de suivi, commande, client, téléphone…" defaultValue={params.q} className="w-72 max-w-full" />
        <FilterSelect
          paramKey="state"
          value={params.state}
          allLabel="Toutes les étapes"
          ariaLabel="Filtrer par étape"
          className="w-48"
          options={STATES.map((s) => ({ value: s, label: RETURN_PARCEL_STATE_LABELS[s] }))}
        />
        {filterActive && (
          <Button variant="ghost" size="sm" render={<Link href="/livraison/retours" />}>
            Réinitialiser
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Undo2}
          title={filterActive ? "Aucun colis retourné ne correspond à ces filtres." : "Aucun colis au statut « Retourné » pour le moment."}
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <ReturnParcelsTable rows={rows} receptionText={receptionText} />
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/livraison/retours" searchParams={{ q: params.q, state: params.state }} />
        </div>
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
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
