import { PageHeader } from "@/components/page-header";
import { OrderForm } from "@/components/orders/order-form";
import { requirePermission } from "@/lib/auth/guards";
import { listSelectableFulfilmentWarehouses } from "@/lib/queries/warehouses";

export const metadata = { title: "Nouvelle commande — ASODITECH Gestion E-commerce" };

export default async function NouvelleCommandePage() {
  await requirePermission("orders.create");
  const warehouses = await listSelectableFulfilmentWarehouses();

  return (
    <div>
      <PageHeader
        title="Nouvelle commande"
        breadcrumbs={[{ label: "Commandes", href: "/commandes" }, { label: "Nouvelle" }]}
      />
      <div className="max-w-4xl">
        <OrderForm warehouses={warehouses} />
      </div>
    </div>
  );
}
