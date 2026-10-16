import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requirePermission } from "@/lib/auth/guards";
import { customerVisibilityWhere } from "@/lib/customers/visibility";
import { prisma } from "@/lib/prisma";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { Button } from "@/components/ui/button";
import { PrintableCustomerCard, PrintButton } from "@/components/customers/customer-barcode";
import { CUSTOMER_CARD_PRINT_CSS } from "@/lib/catalog/label-layout";

export const metadata = { title: "Carte client — ASODITECH Gestion E-commerce" };

/**
 * Printable customer card « CL-000001 » (docs/adr/0060): name + Code 128 +
 * code. Same visibility rule as the customer page; a customer without a code
 * has no card (nothing is generated here — codes are assigned only at
 * creation).
 */
export default async function CustomerCardPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("customers.view");
  const { id } = await params;
  const customer = await prisma.customer.findFirst({
    where: { id, AND: [customerVisibilityWhere(user)] },
    select: { id: true, fullName: true, barcode: true },
  });
  if (!customer) notFound();
  const business = await getReportBusinessInfo();

  return (
    <div className="mx-auto max-w-md space-y-4 p-4">
      <style>{CUSTOMER_CARD_PRINT_CSS}</style>
      <div className="flex items-center justify-between print:hidden">
        <Button variant="ghost" size="sm" render={<Link href={`/clients/${customer.id}`} />}>
          <ArrowLeft className="size-4" />
          Retour au client
        </Button>
        {customer.barcode && <PrintButton />}
      </div>
      {customer.barcode ? (
        <PrintableCustomerCard name={customer.fullName} code={customer.barcode} companyName={business.companyName || null} />
      ) : (
        <p className="text-sm text-muted-foreground">Ce client n&apos;a pas de code client : aucune carte à imprimer.</p>
      )}
    </div>
  );
}
