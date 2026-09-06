import { PageHeader } from "@/components/page-header";
import { OrderForm } from "@/components/orders/order-form";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listSelectableFulfilmentWarehouses } from "@/lib/queries/warehouses";
import { listAssignableCommissionAgents } from "@/lib/queries/commissions";

export const metadata = { title: "Nouvelle commande — ASODITECH Gestion E-commerce" };

export default async function NouvelleCommandePage() {
  const user = await requirePermission("orders.create");
  const [warehouses, commissionAgents] = await Promise.all([
    listSelectableFulfilmentWarehouses(),
    hasPermission(user.role, "commissions.manage") ? listAssignableCommissionAgents() : Promise.resolve([]),
  ]);

  return (
    <div>
      <PageHeader
        title="Nouvelle commande"
        breadcrumbs={[{ label: "Commandes", href: "/commandes" }, { label: "Nouvelle" }]}
      />
      <div className="max-w-4xl">
        <OrderForm
          warehouses={warehouses}
          commissionAgents={commissionAgents.map((a) => ({ id: a.id, name: a.name }))}
        />
      </div>
    </div>
  );
}
