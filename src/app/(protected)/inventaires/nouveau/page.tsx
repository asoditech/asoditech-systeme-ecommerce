import { PageHeader } from "@/components/page-header";
import { StocktakeForm } from "@/components/stocktakes/stocktake-form";
import { requirePermission } from "@/lib/auth/guards";
import { listAccessibleActiveWarehouses } from "@/lib/auth/location-access";

export const metadata = { title: "Nouvel inventaire — ASODITECH Gestion E-commerce" };

export default async function NouvelInventairePage() {
  const user = await requirePermission("inventory.count");
  const warehouses = await listAccessibleActiveWarehouses(user);

  return (
    <div>
      <PageHeader
        title="Nouvel inventaire"
        breadcrumbs={[{ label: "Inventaires", href: "/inventaires" }, { label: "Nouveau" }]}
      />
      <div className="max-w-2xl">
        <StocktakeForm warehouses={warehouses} />
      </div>
    </div>
  );
}
