import { PageHeader } from "@/components/page-header";
import { ReceptionForm } from "@/components/purchases/reception-form";
import { requirePermission } from "@/lib/auth/guards";
import { listAccessibleActiveWarehouses } from "@/lib/auth/location-access";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Nouvelle réception — ASODITECH Gestion E-commerce" };

export default async function NouvelleReceptionPage() {
  const user = await requirePermission("purchases.create");
  const [suppliers, warehouses] = await Promise.all([
    prisma.supplier.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    // ADR 0037: only the locations this user is assigned to can receive stock.
    listAccessibleActiveWarehouses(user),
  ]);
  return (
    <div>
      <PageHeader title="Nouvelle réception" breadcrumbs={[{ label: "Réceptions", href: "/receptions" }, { label: "Nouvelle" }]} />
      <div className="max-w-4xl">
        <ReceptionForm suppliers={suppliers} warehouses={warehouses.map((w) => ({ id: w.id, name: w.name, type: w.type }))} />
      </div>
    </div>
  );
}
