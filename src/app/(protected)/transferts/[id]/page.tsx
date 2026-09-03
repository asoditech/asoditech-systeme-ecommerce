import Link from "next/link";
import { notFound } from "next/navigation";
import { Pencil } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TransferLifecycleActions } from "@/components/transfers/transfer-lifecycle-actions";
import { TransferReceiveForm } from "@/components/transfers/transfer-receive-form";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getStockTransferDetail, getStockTransferAuditTimeline } from "@/lib/queries/transfers";
import { formatDateTime, formatTransferNumber } from "@/lib/format";
import { TRANSFER_STATUS_LABELS } from "@/lib/status-labels";

type TransferDetail = NonNullable<Awaited<ReturnType<typeof getStockTransferDetail>>>;

function lineLabel(line: TransferDetail["lines"][number]) {
  if (line.variation) {
    const attrs = Object.values(line.variation.attributes as Record<string, string>).join(", ");
    return { label: `${line.variation.product.name} (${attrs})`, sku: line.variation.sku };
  }
  if (line.product) return { label: line.product.name, sku: line.product.sku };
  return { label: "Article supprimé du catalogue", sku: "—" };
}

export default async function TransfertDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("inventory.view");
  const { id } = await params;
  const transfer = await getStockTransferDetail(id);
  if (!transfer) notFound();

  const canTransfer = hasPermission(user.role, "inventory.transfer");
  const timeline = await getStockTransferAuditTimeline(id);
  const ref = formatTransferNumber(transfer.transferNumber);
  const lines = transfer.lines.map((l) => ({ ...l, ...lineLabel(l) }));

  return (
    <div>
      <PageHeader
        title={ref}
        breadcrumbs={[{ label: "Transferts", href: "/transferts" }, { label: ref }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={transfer.status} labels={TRANSFER_STATUS_LABELS} />
            {canTransfer && transfer.status === "BROUILLON" && (
              <>
                <Button variant="outline" render={<Link href={`/transferts/${transfer.id}/modifier`} />}>
                  <Pencil className="size-4" />
                  Modifier
                </Button>
                <TransferLifecycleActions transferId={transfer.id} />
              </>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Articles</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Article</TableHead>
                    <TableHead>Envoyé</TableHead>
                    <TableHead>Reçu</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell>
                        <p className="font-medium">{l.label}</p>
                        <p className="text-xs text-muted-foreground">{l.sku}</p>
                      </TableCell>
                      <TableCell>{l.quantitySent}</TableCell>
                      <TableCell
                        className={
                          l.quantityReceived != null && l.quantityReceived < l.quantitySent
                            ? "font-medium text-destructive"
                            : ""
                        }
                      >
                        {l.quantityReceived ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {canTransfer && transfer.status === "EN_TRANSIT" && (
            <Card>
              <CardHeader>
                <CardTitle>Réception</CardTitle>
              </CardHeader>
              <CardContent>
                <TransferReceiveForm
                  transferId={transfer.id}
                  lines={lines.map((l) => ({
                    id: l.id,
                    label: l.label,
                    sku: l.sku,
                    quantitySent: l.quantitySent,
                  }))}
                />
              </CardContent>
            </Card>
          )}

          {transfer.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap">{transfer.notes}</CardContent>
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
              <CardTitle>Itinéraire</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">Source :</span> {transfer.source.name}
              </p>
              <p>
                <span className="text-muted-foreground">Destination :</span> {transfer.destination.name}
                {!transfer.destination.isActive && (
                  <span className="text-destructive"> (inactif)</span>
                )}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Suivi</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>
                <span className="text-muted-foreground">Créé par :</span>{" "}
                {transfer.createdBy?.name ?? "—"} · {formatDateTime(transfer.createdAt)}
              </p>
              {transfer.dispatchedAt && (
                <p>
                  <span className="text-muted-foreground">Expédié par :</span>{" "}
                  {transfer.dispatchedBy?.name ?? "—"} · {formatDateTime(transfer.dispatchedAt)}
                </p>
              )}
              {transfer.receivedAt && (
                <p>
                  <span className="text-muted-foreground">Reçu par :</span>{" "}
                  {transfer.receivedBy?.name ?? "—"} · {formatDateTime(transfer.receivedAt)}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
