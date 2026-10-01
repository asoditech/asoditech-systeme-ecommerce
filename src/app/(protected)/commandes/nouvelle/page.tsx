import { PageHeader } from "@/components/page-header";
import { OrderForm } from "@/components/orders/order-form";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { listAccessibleActiveWarehouses } from "@/lib/auth/location-access";
import { listAssignableCommissionAgents } from "@/lib/queries/commissions";
import { listActiveProvidersForCityGuidance } from "@/lib/queries/delivery";
import { cityGuidanceFromProviders } from "@/lib/integrations/delivery/city-guidance";

export const metadata = { title: "Nouvelle commande — ASODITECH Gestion E-commerce" };

export default async function NouvelleCommandePage() {
  const user = await requirePermission("orders.create");
  const [warehouses, commissionAgents, providers] = await Promise.all([
    listAccessibleActiveWarehouses(user),
    userHasPermission(user, "commissions.manage") ? listAssignableCommissionAgents() : Promise.resolve([]),
    listActiveProvidersForCityGuidance(),
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
          canConfirm={userHasPermission(user, "orders.confirm")}
          cityGuidance={cityGuidanceFromProviders(providers)}
        />
      </div>
    </div>
  );
}
