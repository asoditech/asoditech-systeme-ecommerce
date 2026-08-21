import { PageHeader } from "@/components/page-header";
import { CustomerForm } from "@/components/customers/customer-form";
import { requirePermission } from "@/lib/auth/guards";

export const metadata = { title: "Nouveau client — ASODITECH Gestion E-commerce" };

export default async function NouveauClientPage() {
  await requirePermission("customers.create");

  return (
    <div>
      <PageHeader
        title="Nouveau client"
        breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: "Nouveau" }]}
      />
      <div className="max-w-2xl">
        <CustomerForm />
      </div>
    </div>
  );
}
