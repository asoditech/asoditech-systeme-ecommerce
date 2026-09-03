import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StocktakeCountForm } from "@/components/stocktakes/stocktake-count-form";
import { StocktakeLifecycleActions } from "@/components/stocktakes/stocktake-lifecycle-actions";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getStocktakeSessionDetail, getStocktakeAuditTimeline } from "@/lib/queries/stocktakes";
import { formatDateTime, formatStocktakeNumber } from "@/lib/format";
import { STOCKTAKE_STATUS_LABELS } from "@/lib/status-labels";

export default async function InventaireDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("inventory.view");
  const { id } = await params;
  const session = await getStocktakeSessionDetail(id);
  if (!session) notFound();

  const canCount = hasPermission(user.role, "inventory.count");
  const timeline = await getStocktakeAuditTimeline(id);
  const ref = formatStocktakeNumber(session.sessionNumber);
  const isOpen = session.status === "EN_COURS";

  return (
    <div>
      <PageHeader
        title={ref}
        breadcrumbs={[{ label: "Inventaires", href: "/inventaires" }, { label: ref }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={session.status} labels={STOCKTAKE_STATUS_LABELS} />
            {canCount && isOpen && (
              <StocktakeLifecycleActions sessionId={session.id} countedLines={session.summary.counted} />
            )}
          </div>
        }
      />

      {session.summary.stale > 0 && isOpen && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <span className="font-medium text-destructive">
            {session.summary.stale} ligne(s) périmée(s) :
          </span>{" "}
          le stock de ces articles a changé depuis leur comptage. Recomptez-les avant de clôturer — la clôture
          est bloquée tant qu&apos;une ligne comptée est périmée.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Comptage</CardTitle>
            </CardHeader>
            <CardContent>
              {isOpen && canCount ? (
                <StocktakeCountForm
                  sessionId={session.id}
                  lines={session.lines.map((l) => ({
                    id: l.id,
                    label: l.label,
                    sku: l.sku,
                    systemQuantityAtCount: l.systemQuantityAtCount,
                    currentQuantity: l.currentQuantity,
                    countedQuantity: l.countedQuantity,
                    isStale: l.isStale,
                  }))}
                />
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Article</TableHead>
                        <TableHead>Système</TableHead>
                        <TableHead>Compté</TableHead>
                        <TableHead>Écart</TableHead>
                        <TableHead>Ajustement</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {session.lines.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell>
                            <p className="font-medium">{l.label}</p>
                            <p className="text-xs text-muted-foreground">{l.sku}</p>
                          </TableCell>
                          <TableCell>{l.systemQuantityAtCount}</TableCell>
                          <TableCell>{l.countedQuantity ?? "— non compté"}</TableCell>
                          <TableCell
                            className={l.variance != null && l.variance !== 0 ? "font-medium text-destructive" : ""}
                          >
                            {l.variance == null ? "—" : l.variance > 0 ? `+${l.variance}` : l.variance}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {l.applied
                              ? l.appliedMovementQuantity != null
                                ? `${l.appliedMovementQuantity} unité(s)`
                                : "aucun (écart nul)"
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {session.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap">{session.notes}</CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Historique</CardTitle>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun évènement enregistré.</p>
              ) : (
                <ul className="space-y-3">
                  {timeline.map((e) => (
                    <li key={e.id} className="text-sm">
                      <p>
                        <span className="font-medium">{e.actorUser?.name ?? "Système"}</span>{" "}
                        <span className="text-muted-foreground">— {e.action}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Détails</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">Entrepôt :</span> {session.warehouse.name}
                {!session.warehouse.isActive && <span className="text-destructive"> (inactif)</span>}
              </p>
              <p>
                <span className="text-muted-foreground">Lignes :</span> {session.summary.counted} comptée(s) /{" "}
                {session.summary.total}
              </p>
              {session.summary.stale > 0 && (
                <p className="text-destructive">
                  <span className="text-muted-foreground">Périmées :</span> {session.summary.stale}
                </p>
              )}
              {session.status === "CLOTURE" && (
                <p>
                  <span className="text-muted-foreground">Ajustements appliqués :</span> {session.summary.applied}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Suivi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">Démarré par :</span>{" "}
                {session.startedByName ?? "—"} · {formatDateTime(session.createdAt)}
              </p>
              {session.closedAt && (
                <p>
                  <span className="text-muted-foreground">Clôturé par :</span>{" "}
                  {session.closedByName ?? "—"} · {formatDateTime(session.closedAt)}
                </p>
              )}
              {session.status === "ANNULE" && <Badge variant="outline">Inventaire annulé</Badge>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
