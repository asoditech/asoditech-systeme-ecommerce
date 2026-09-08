import { FileText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { ClickableTableRow } from "@/components/clickable-table-row";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { listInvoiceableShipments } from "@/lib/queries/delivery-invoice";
import { formatCurrency, formatDate, displayOrderNumber } from "@/lib/format";
import { SHIPMENT_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Factures de livraison — ASODITECH Gestion E-commerce" };

export default async function FacturesLivraisonPage() {
  await requirePermission("delivery.view");
  const shipments = await listInvoiceableShipments();

  return (
    <div>
      <PageHeader
        title="Factures de livraison"
        description="Sélectionnez une expédition pour générer sa facture (impression / PDF)."
      />

      {shipments.length === 0 ? (
        <EmptyState icon={FileText} title="Aucune expédition." description="Les factures apparaîtront dès qu'une expédition sera créée." />
      ) : (
        <div className="rounded-lg border">
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Ville</TableHead>
                <TableHead>Transporteur</TableHead>
                <TableHead>Suivi</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Montant</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipments.map((s) => (
                <ClickableTableRow key={s.id} href={`/livraison/factures/${s.id}`}>
                  <TableCell className="font-medium">{displayOrderNumber(s.order)}</TableCell>
                  <TableCell>{s.order.customer.fullName}</TableCell>
                  <TableCell className="text-muted-foreground">{s.order.shippingCity ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{s.provider.name}</TableCell>
                  <TableCell className="text-muted-foreground">{s.trackingNumber ?? "—"}</TableCell>
                  <TableCell><StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} /></TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(s.order.total.toString(), s.order.currency)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(s.createdAt)}</TableCell>
                </ClickableTableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
