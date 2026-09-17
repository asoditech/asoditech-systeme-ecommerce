import { PageHeader } from "@/components/page-header";
import { TransferForm } from "@/components/transfers/transfer-form";
import { requirePermission } from "@/lib/auth/guards";
import { listAccessibleActiveWarehouses } from "@/lib/auth/location-access";

export const metadata = { title: "Nouveau transfert — ASODITECH Gestion E-commerce" };

export default async function NouveauTransfertPage() {
  const user = await requirePermission("inventory.transfer");
  const warehouses = await listAccessibleActiveWarehouses(user);

  return (
    <div>
      <PageHeader
        title="Nouveau transfert"
        breadcrumbs={[{ label: "Transferts", href: "/transferts" }, { label: "Nouveau" }]}
      />
      <div className="max-w-3xl">
        <TransferForm warehouses={warehouses} />
      </div>
    </div>
  );
}
