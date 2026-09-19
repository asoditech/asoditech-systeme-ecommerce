import Link from "next/link";
import { ScanBarcode } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FilterSearchInput } from "@/components/filter-search-input";
import { requirePermission } from "@/lib/auth/guards";
import { findTraceUnits, getUnitTraceability } from "@/lib/queries/traceability";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { INVENTORY_MOVEMENT_TYPE_LABELS, WAREHOUSE_TYPE_LABELS } from "@/lib/status-labels";
import { variantLabel } from "@/lib/catalog/lookup";

export const metadata = { title: "Traçabilité — ASODITECH Gestion E-commerce" };

/**
 * Traceability of ONE product / variant (docs/adr/0038, 0040): scan a barcode
 * or type a reference / name → identity, where the stock is now, and the full
 * movement history with its source documents. One ledger, no second history;
 * rows are scoped to the viewer's channels.
 */
export default async function TracabilitePage({ searchParams }: { searchParams: Promise<{ q?: string; unit?: string }> }) {
  // traceability.view is only usable when the tenant's business mode enables the
  // `traceability` capability (docs/adr/0041) — otherwise it is not in the
  // effective set and this redirects.
  const user = await requirePermission("traceability.view");
  const params = await searchParams;
  const q = params.q?.trim() ?? "";

  const candidates = q ? await findTraceUnits(q) : [];
  const chosenKey = params.unit ?? (candidates.length === 1 ? (candidates[0].variationId ? `v:${candidates[0].variationId}` : `p:${candidates[0].productId}`) : null);
  const chosen = chosenKey
    ? candidates.find((c) => (c.variationId ? `v:${c.variationId}` : `p:${c.productId}`) === chosenKey) ??
      // a unit key from a previous search still resolves even when the query changed
      null
    : null;
  const trace = chosen ? await getUnitTraceability(user, { productId: chosen.productId, variationId: chosen.variationId }) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Traçabilité" description="Suivez un article de son entrée en stock à sa sortie : emplacement, mouvements, réceptions, ventes, retours." />
      <FilterSearchInput placeholder="Code-barres, référence, SKU ou nom…" defaultValue={params.q} className="w-96" />

      {!q && <EmptyState icon={ScanBarcode} title="Scannez ou saisissez un code-barres, une référence ou un nom." />}
      {q && candidates.length === 0 && <EmptyState icon={ScanBarcode} title="Aucun article trouvé." />}

      {q && candidates.length > 1 && !trace && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">{candidates.length} articles correspondent</CardTitle>
          </CardHeader>
          <CardContent className="divide-y text-sm">
            {candidates.map((u) => {
              const key = u.variationId ? `v:${u.variationId}` : `p:${u.productId}`;
              return (
                <Link key={key} href={`/tracabilite?q=${encodeURIComponent(q)}&unit=${encodeURIComponent(key)}`} className="flex items-center justify-between py-2 hover:underline">
                  <span>
                    {u.name}
                    {u.variantLabel && <span className="text-muted-foreground"> — {u.variantLabel}</span>}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{u.primaryBarcode ?? u.sku}</span>
                </Link>
              );
            })}
          </CardContent>
        </Card>
      )}

      {trace && (
        <>
          <Card>
            <CardHeader className="flex-row flex-wrap items-center gap-3 space-y-0">
              <CardTitle className="text-lg">{trace.identity.name}</CardTitle>
              {trace.identity.variantAttributes && <Badge variant="secondary">{variantLabel(trace.identity.variantAttributes)}</Badge>}
              {trace.identity.reference && <Badge variant="outline">Réf. modèle {trace.identity.reference}</Badge>}
              {trace.identity.category && <Badge variant="outline">{trace.identity.category}</Badge>}
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div>SKU <span className="font-mono">{trace.identity.sku}</span></div>
              <div className="flex flex-wrap gap-2">
                {trace.identity.barcodes.length === 0 && <span className="text-muted-foreground">Aucun code-barres.</span>}
                {trace.identity.barcodes.map((b) => (
                  <Badge key={b.code} variant={b.isPrimary ? "default" : "outline"} className="font-mono">{b.code}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Où est le stock maintenant</CardTitle>
            </CardHeader>
            <CardContent>
              {trace.stock.length === 0 ? (
                <p className="text-sm text-muted-foreground">Cet article n&apos;est suivi dans aucun emplacement.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Emplacement</TableHead>
                      <TableHead className="text-right">Physique</TableHead>
                      <TableHead className="text-right">Réservé</TableHead>
                      <TableHead className="text-right">Disponible</TableHead>
                      <TableHead className="text-right">Endommagé</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trace.stock.map((s) => (
                      <TableRow key={s.warehouseId}>
                        <TableCell className="font-medium">
                          {s.warehouseName} <span className="text-xs text-muted-foreground">({WAREHOUSE_TYPE_LABELS[s.warehouseType]})</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{s.onHand}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.reserved}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.available}</TableCell>
                        <TableCell className="text-right tabular-nums">{s.damaged}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-[15px]">Historique des mouvements</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                Journal unique et non modifiable. Les mouvements antérieurs à la mise en place de la traçabilité complète n&apos;ont ni
                variation signée, ni solde, ni document d&apos;origine — ils sont signalés « historique ancien » et jamais reconstitués.
              </p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Mouvement</TableHead>
                      <TableHead>Emplacement</TableHead>
                      <TableHead className="text-right">Effet</TableHead>
                      <TableHead className="text-right">Solde</TableHead>
                      <TableHead className="text-right">Coût</TableHead>
                      <TableHead>Document</TableHead>
                      <TableHead>Par</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trace.movements.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(m.at)}</TableCell>
                        <TableCell>
                          {INVENTORY_MOVEMENT_TYPE_LABELS[m.type] ?? m.type}
                          {m.legacy && <Badge variant="outline" className="ml-2 text-[10px]">historique ancien</Badge>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{m.location}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {m.onHandDelta === null ? `${m.quantity}` : m.onHandDelta > 0 ? `+${m.onHandDelta}` : `${m.onHandDelta}`}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{m.onHandAfter ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.unitCost !== null ? formatCurrency(String(m.unitCost)) : "—"}</TableCell>
                        <TableCell>
                          {m.document ? (
                            <Link href={m.document.href} className="hover:underline">
                              {m.document.label}
                              {m.document.extra && <span className="text-muted-foreground"> · {m.document.extra}</span>}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">{m.reason ?? "—"}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{m.actor ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                    {trace.movements.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center text-muted-foreground">
                          Aucun mouvement visible.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
