import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { TransferForm } from "@/components/transfers/transfer-form";
import { requirePermission } from "@/lib/auth/guards";
import { getStockTransferDetail } from "@/lib/queries/transfers";
import { listAccessibleActiveWarehouses } from "@/lib/auth/location-access";
import { displayTransferNumber } from "@/lib/format";
import { userHasPermission } from "@/lib/auth/permissions";
import { isTransferCostOverrideEnabled } from "@/lib/transfers";
import { canEnterTransferCost } from "@/lib/transfer-cost-ui";

export const metadata = { title: "Modifier le transfert — ASODITECH Gestion E-commerce" };

export default async function ModifierTransfertPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("inventory.transfer");
  const { id } = await params;
  const transfer = await getStockTransferDetail(id, user);
  if (!transfer) notFound();
  // Only a BROUILLON draft is editable.
  if (transfer.status !== "BROUILLON") redirect(`/transferts/${id}`);

  const warehouses = await listAccessibleActiveWarehouses(user);
  // Purchase costs reach the browser only with finance.view (docs/adr/0043);
  // the field itself also needs the tenant setting.
  const canViewFinance = userHasPermission(user, "finance.view");
  const costEntry = canEnterTransferCost(await isTransferCostOverrideEnabled(), canViewFinance);
  const ref = displayTransferNumber(transfer);

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
          costEntry={costEntry}
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
              ...(costEntry
                ? {
                    destinationUnitCost: l.destinationUnitCost?.toString() ?? null,
                    globalCost: (l.variation ? (l.variation.cost ?? l.variation.product.cost) : l.product?.cost)?.toString() ?? null,
                  }
                : {}),
            })),
          }}
        />
      </div>
    </div>
  );
}
