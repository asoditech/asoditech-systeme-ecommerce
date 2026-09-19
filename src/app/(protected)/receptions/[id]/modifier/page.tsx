import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ReceptionForm } from "@/components/purchases/reception-form";
import { requirePermission } from "@/lib/auth/guards";
import { listAccessibleActiveWarehouses } from "@/lib/auth/location-access";
import { getReceptionDetail } from "@/lib/queries/purchases";
import { displayReceptionNumber } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Modifier la réception — ASODITECH Gestion E-commerce" };

/** Only a DRAFT can be edited — a validated reception is immutable (docs/adr/0040). */
export default async function ModifierReceptionPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("purchases.create");
  const { id } = await params;
  const r = await getReceptionDetail(id);
  if (!r) notFound();
  if (r.status !== "BROUILLON") redirect(`/receptions/${r.id}`);
  const [suppliers, warehouses] = await Promise.all([
    prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    listAccessibleActiveWarehouses(user),
  ]);
  return (
    <div>
      <PageHeader
        title={`Modifier ${displayReceptionNumber(r)}`}
        breadcrumbs={[{ label: "Réceptions", href: "/receptions" }, { label: displayReceptionNumber(r), href: `/receptions/${r.id}` }, { label: "Modifier" }]}
      />
      <div className="max-w-4xl">
        <ReceptionForm
          suppliers={suppliers}
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, type: w.type }))}
          reception={{
            id: r.id,
            supplierId: r.supplierId,
            warehouseId: r.warehouseId,
            supplierReference: r.supplierReference ?? "",
            notes: r.notes ?? "",
            date: r.receptionDate.toISOString().slice(0, 10),
            lines: r.lines.map((l) => ({
              key: l.variationId ? `v:${l.variationId}` : `p:${l.productId}`,
              productId: l.productId,
              variationId: l.variationId,
              label: l.nameSnapshot,
              sku: l.skuSnapshot,
              quantity: l.quantity,
              unitCost: Number(l.unitCost),
            })),
          }}
        />
      </div>
    </div>
  );
}
