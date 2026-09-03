import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { TransferForm } from "@/components/transfers/transfer-form";
import { requirePermission } from "@/lib/auth/guards";
import { getStockTransferDetail } from "@/lib/queries/transfers";
import { listSelectableFulfilmentWarehouses } from "@/lib/queries/warehouses";
import { formatTransferNumber } from "@/lib/format";

export const metadata = { title: "Modifier le transfert — ASODITECH Gestion E-commerce" };

export default async function ModifierTransfertPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission("inventory.transfer");
  const { id } = await params;
  const transfer = await getStockTransferDetail(id);
  if (!transfer) notFound();
  // Only a BROUILLON draft is editable.
  if (transfer.status !== "BROUILLON") redirect(`/transferts/${id}`);

  const warehouses = await listSelectableFulfilmentWarehouses();
  const ref = formatTransferNumber(transfer.transferNumber);

  return (
    <div>
      <PageHeader
        title={`Modifier ${ref}`}
        breadcrumbs={[
          { label: "Transferts", href: "/transferts" },
          { label: ref, href: `/transferts/${id}` },
          { label: "Modifier" },
        ]}
      />
      <div className="max-w-3xl">
        <TransferForm
          warehouses={warehouses}
          mode="edit"
          transfer={{
            id: transfer.id,
            sourceWarehouseId: transfer.source.id,
            sourceName: transfer.source.name,
            destinationWarehouseId: transfer.destination.id,
            destinationName: transfer.destination.name,
            notes: transfer.notes ?? "",
            lines: transfer.lines.map((l) => ({
              productId: l.productId,
              variationId: l.variationId,
              label: l.variation
                ? `${l.variation.product.name} (${Object.values(l.variation.attributes as Record<string, string>).join(", ")})`
                : (l.product?.name ?? "Article supprimé"),
              sku: l.variation?.sku ?? l.product?.sku ?? "—",
              quantitySent: l.quantitySent,
            })),
          }}
        />
      </div>
    </div>
  );
}
