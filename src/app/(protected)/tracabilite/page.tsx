import Link from "next/link";
import { ChevronRight, ScanBarcode } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TraceScanButton } from "@/components/traceability/trace-scan-button";
import { TraceUnitPicker } from "@/components/traceability/trace-unit-picker";
import { inactiveUnitLabel } from "@/lib/traceability-scan";
import { scanMissHint } from "@/lib/catalog/scan-input";
import { requirePermission } from "@/lib/auth/guards";
import { findTraceUnits, getUnitTraceability } from "@/lib/queries/traceability";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { INVENTORY_MOVEMENT_TYPE_LABELS, WAREHOUSE_TYPE_LABELS } from "@/lib/status-labels";
import { variantLabel } from "@/lib/catalog/lookup";
import { productCostVisibility } from "@/lib/auth/cost-visibility";

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
  // Movement unit costs: the query sends a reception's purchase price with
  // `purchases.view`, any other cost with `finance.view` (docs/adr/0052).
  const { cost, purchasePrices } = productCostVisibility(user);
  const showCost = cost || purchasePrices;
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Search field + product picker; keyed on `q` so back/forward navigation shows that search again. */}
        <TraceUnitPicker key={q} defaultValue={q} className="w-full sm:w-96" />
        {/* Camera scan = the same `?q=` search, read-only; manual entry and USB/Bluetooth scanners keep working. */}
        <TraceScanButton />
      </div>

      {!q && <EmptyState icon={ScanBarcode} title="Scannez ou saisissez un code-barres, une référence ou un nom." />}
      {q && candidates.length === 0 && <EmptyState icon={ScanBarcode} title="Aucun article trouvé." description={scanMissHint(q)?.message} />}

      {q && candidates.length > 1 && !trace && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">{candidates.length} articles correspondent</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            <p className="px-2 pb-2 text-xs text-muted-foreground">Choisissez l&apos;article à tracer.</p>
            <ul className="divide-y rounded-lg border" aria-label="Articles correspondants">
              {candidates.map((u) => {
                const key = u.variationId ? `v:${u.variationId}` : `p:${u.productId}`;
                return (
                  <li key={key}>
                    <Link
                      href={`/tracabilite?q=${encodeURIComponent(q)}&unit=${encodeURIComponent(key)}`}
                      className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 font-medium">
                          {u.name}
                          {u.variantLabel && <span className="font-normal text-muted-foreground">— {u.variantLabel}</span>}
                          {inactiveUnitLabel(u.status) && (
                            <Badge variant="outline" className="h-4 px-1 text-[10px]">
                              {inactiveUnitLabel(u.status)}
                            </Badge>
                          )}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[u.sku, u.primaryBarcode, u.categoryName].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {trace && (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center gap-3 space-y-0">
              <CardTitle className="text-lg">{trace.identity.name}</CardTitle>
              {trace.identity.variantAttributes && <Badge variant="secondary">{variantLabel(trace.identity.variantAttributes)}</Badge>}
              {trace.identity.reference && <Badge variant="outline">Réf. modèle {trace.identity.reference}</Badge>}
              {trace.identity.category && <Badge variant="outline">{trace.identity.category}</Badge>}
              {chosen && inactiveUnitLabel(chosen.status) && (
                <Badge variant="outline" title="Article non vendable : son historique reste consultable.">
                  {inactiveUnitLabel(chosen.status)}
                </Badge>
              )}
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

          {trace.referenceCost && (
            <Card>
              <CardHeader>
                <CardTitle className="text-[15px]">Coût d&apos;achat actuel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {trace.referenceCost.global === null && trace.referenceCost.locations.length === 0 ? (
                  <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-400">
                    Coût d&apos;achat non renseigné pour cet article.{" "}
                    <Link href={trace.productHref} className="font-medium underline underline-offset-2">
                      Renseignez-le sur la fiche produit
                    </Link>{" "}
                    — les marges et la valorisation du stock restent incomplètes tant qu&apos;il manque.
                  </p>
                ) : (
                  <>
                    <p>
                      <span className="text-lg font-semibold tabular-nums">
                        {trace.referenceCost.global !== null ? formatCurrency(String(trace.referenceCost.global)) : "Non renseigné"}
                      </span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {trace.referenceCost.globalSource === "variation"
                          ? "coût de la variante"
                          : trace.referenceCost.globalSource === "product"
                            ? "coût du produit (la variante n'a pas de coût propre)"
                            : "aucun coût sur la fiche produit"}
                      </span>
                    </p>
                    {trace.referenceCost.locations.length > 0 && (
                      <ul className="flex flex-wrap gap-2 text-xs">
                        {trace.referenceCost.locations.map((l) => (
                          <li key={l.warehouseId} className="rounded-md border px-2 py-1">
                            {l.warehouseName} : <span className="font-medium tabular-nums">{formatCurrency(String(l.cost))}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                <p className="text-xs text-muted-foreground">
                  Coût de référence actuel (repris pour les prochaines ventes). L&apos;historique ci-dessous montre le coût enregistré par
                  chaque mouvement : il n&apos;est jamais recalculé ni complété après coup.
                </p>
              </CardContent>
            </Card>
          )}

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
                      {showCost && <TableHead className="text-right">Coût</TableHead>}
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
                        {showCost && (
                          <TableCell className="text-right tabular-nums">
                            {m.unitCost !== null ? (
                              formatCurrency(String(m.unitCost))
                            ) : m.costState === "hidden" ? (
                              <span className="text-xs text-muted-foreground" title="Ce coût n'est visible qu'avec l'accès Finance.">
                                masqué
                              </span>
                            ) : (
                              <span
                                className="text-xs text-muted-foreground italic"
                                title="Seules les réceptions, les transferts reçus avec un coût de destination et les ventes magasin enregistrent un coût sur le mouvement. Voir « Coût d'achat actuel » pour le coût de référence."
                              >
                                non enregistré
                              </span>
                            )}
                          </TableCell>
                        )}
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
                        <TableCell colSpan={showCost ? 8 : 7} className="text-center text-muted-foreground">
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
