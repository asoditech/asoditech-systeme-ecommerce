import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterSelect } from "@/components/filter-select";
import { FilterSearchInput } from "@/components/filter-search-input";
import { ProductExportPanel } from "@/components/products/product-export-panel";
import { requirePermission } from "@/lib/auth/guards";
import { listCategories } from "@/lib/queries/products";
import { EXPORT_CANDIDATE_LIMIT, listExportCandidates, type ExportFilters } from "@/lib/catalog/export/load";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Exporter des produits — ASODITECH Gestion E-commerce" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined =>
  v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/**
 * Products → filter → select → WooCommerce / Shopify CSV (docs/adr/0054).
 * Same permission as editing the catalogue (`products.edit`); the export
 * never creates anything in a store — the user imports the file.
 */
export default async function ProductExportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("products.edit");
  const sp = await searchParams;
  const filters: ExportFilters = {
    q: one(sp.q),
    status: pick(one(sp.status), ["ACTIF", "BROUILLON", "ARCHIVE", "all"] as const),
    categoryId: one(sp.categoryId),
    type: pick(one(sp.type), ["simple", "variable"] as const),
    stock: pick(one(sp.stock), ["in", "out"] as const),
    source: pick(one(sp.source), ["INTERNE", "WOOCOMMERCE", "SHOPIFY", "all"] as const),
    notPublishedTo: pick(one(sp.notPublishedTo), ["woocommerce", "shopify"] as const),
    createdFrom: one(sp.createdFrom),
    createdTo: one(sp.createdTo),
  };
  const [{ rows, total }, categories] = await Promise.all([listExportCandidates(filters), listCategories()]);
  const preserved = Object.entries(sp).filter(([k, v]) => k !== "createdFrom" && k !== "createdTo" && typeof v === "string" && v) as [string, string][];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Exporter des produits"
        description="Filtrez, sélectionnez, puis téléchargez un CSV au format WooCommerce ou Shopify à importer dans votre boutique."
        actions={
          <Button variant="outline" render={<Link href="/produits" />}>
            <ArrowLeft className="size-4" />
            Produits
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <FilterSearchInput placeholder="Nom, SKU, référence, code-barres…" defaultValue={filters.q} />
        <FilterSelect
          paramKey="status"
          value={filters.status}
          allLabel="Actifs (par défaut)"
          options={[
            { value: "all", label: "Tous les statuts" },
            { value: "BROUILLON", label: "Brouillons" },
            { value: "ARCHIVE", label: "Désactivés (archivés)" },
          ]}
        />
        <FilterSelect paramKey="categoryId" value={filters.categoryId} allLabel="Toutes les catégories" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        <FilterSelect paramKey="type" value={filters.type} allLabel="Simples et à variations" options={[{ value: "simple", label: "Simples" }, { value: "variable", label: "À variations" }]} />
        <FilterSelect paramKey="stock" value={filters.stock} allLabel="Tout stock" options={[{ value: "in", label: "En stock" }, { value: "out", label: "En rupture" }]} />
        <FilterSelect
          paramKey="source"
          value={filters.source}
          allLabel="Créés dans ASODITECH (par défaut)"
          options={[
            { value: "all", label: "Toutes origines" },
            { value: "WOOCOMMERCE", label: "Importés de WooCommerce" },
            { value: "SHOPIFY", label: "Importés de Shopify" },
          ]}
        />
        <FilterSelect
          paramKey="notPublishedTo"
          value={filters.notPublishedTo}
          allLabel="Publiés ou non"
          options={[
            { value: "woocommerce", label: "Pas encore sur WooCommerce" },
            { value: "shopify", label: "Pas encore sur Shopify" },
          ]}
        />
        <form className="flex flex-wrap items-center gap-2" action="/produits/exporter">
          {preserved.map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <label htmlFor="createdFrom" className="text-xs font-medium text-muted-foreground">
            Créés du
          </label>
          <Input id="createdFrom" type="date" name="createdFrom" defaultValue={filters.createdFrom} className="h-8 w-38" />
          <label htmlFor="createdTo" className="text-xs font-medium text-muted-foreground">
            au
          </label>
          <Input id="createdTo" type="date" name="createdTo" defaultValue={filters.createdTo} className="h-8 w-38" />
          <Button type="submit" size="sm" variant="outline">
            Appliquer
          </Button>
        </form>
      </div>

      <ProductExportPanel
        rows={rows.map((r) => ({ ...r, createdAt: formatDate(r.createdAt) }))}
        total={total}
        limit={EXPORT_CANDIDATE_LIMIT}
      />
    </div>
  );
}
