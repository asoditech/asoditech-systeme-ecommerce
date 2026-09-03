import { PageHeader } from "@/components/page-header";
import { StocktakeForm } from "@/components/stocktakes/stocktake-form";
import { requirePermission } from "@/lib/auth/guards";
import { listSelectableFulfilmentWarehouses } from "@/lib/queries/warehouses";

export const metadata = { title: "Nouvel inventaire — ASODITECH Gestion E-commerce" };

export default async function NouvelInventairePage() {
  await requirePermission("inventory.count");
  const warehouses = await listSelectableFulfilmentWarehouses();

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
