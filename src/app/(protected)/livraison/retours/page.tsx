import Link from "next/link";
import { ChevronRight, HelpCircle, PackageCheck, PackageOpen, PackageSearch, Undo2 } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { DataTablePagination } from "@/components/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ReceiveParcelButton, ReturnParcelStateBadge, ReturnsScanLot } from "@/components/returns/returns-workspace";
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
 * this page calls a carrier or changes an order / shipment status.
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>N° de suivi</TableHead>
                <TableHead>Destinataire</TableHead>
                <TableHead>Emplacement d&apos;origine</TableHead>
                <TableHead className="text-right">Unités retournées</TableHead>
                <TableHead>Étape</TableHead>
                <TableHead>Réception</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.shipmentId}>
                  <TableCell>
                    <Link href={`/commandes/${p.orderId}`} className="font-medium underline-offset-2 hover:underline">
                      {p.orderLabel}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div>{p.trackingNumber ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{p.providerName}</div>
                  </TableCell>
                  <TableCell>
                    <div>{p.recipientName}</div>
                    <div className="text-xs text-muted-foreground">{[p.recipientPhone, p.city].filter(Boolean).join(" · ") || "—"}</div>
                  </TableCell>
                  <TableCell>{p.warehouseName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.returnedUnits} / {p.shippedUnits}
                  </TableCell>
                  <TableCell>
                    <ReturnParcelStateBadge state={p.state} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.pendingReception ? (
                      <>
                        {formatDateTime(p.pendingReception.receivedAt)}
                        {p.pendingReception.receivedByName ? ` · ${p.pendingReception.receivedByName}` : ""}
                      </>
                    ) : p.lastInspection?.inspectedAt ? (
                      <>
                        Inspecté le {formatDateTime(p.lastInspection.inspectedAt)}
                        {p.lastInspection.inspectedByName ? ` · ${p.lastInspection.inspectedByName}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <ReceiveParcelButton parcel={p} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination page={page} pageSize={pageSize} total={total} basePath="/livraison/retours" searchParams={{ q: params.q, state: params.state }} />
        </div>
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Seuls les colis que le transporteur indique « Retourné » apparaissent ici. Réceptionner un colis ne modifie pas le
          stock : seules les unités jugées revendables à l&apos;inspection reviennent en stock disponible, à leur emplacement
          d&apos;origine. Le statut de la commande et celui du transporteur ne changent pas.
        </span>
      </p>
    </div>
  );
}
