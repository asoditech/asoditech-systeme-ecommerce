import { PageHeader } from "@/components/page-header";
import { ProductForm } from "@/components/products/product-form";
import { requirePermission } from "@/lib/auth/guards";
import { listCategories } from "@/lib/queries/products";

export const metadata = { title: "Nouveau produit — ASODITECH Gestion E-commerce" };

export default async function NouveauProduitPage() {
  await requirePermission("products.create");
  const categories = await listCategories();

  return (
    <div>
      <PageHeader
        title="Nouveau produit"
        breadcrumbs={[{ label: "Produits", href: "/produits" }, { label: "Nouveau" }]}
      />
      <div className="max-w-2xl">
        <ProductForm categories={categories} />
      </div>
    </div>
  );
}
