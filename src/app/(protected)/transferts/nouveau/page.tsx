import { PageHeader } from "@/components/page-header";
import { TransferForm } from "@/components/transfers/transfer-form";
import { requirePermission } from "@/lib/auth/guards";
import { listSelectableFulfilmentWarehouses } from "@/lib/queries/warehouses";

export const metadata = { title: "Nouveau transfert — ASODITECH Gestion E-commerce" };

export default async function NouveauTransfertPage() {
  await requirePermission("inventory.transfer");
  const warehouses = await listSelectableFulfilmentWarehouses();

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
