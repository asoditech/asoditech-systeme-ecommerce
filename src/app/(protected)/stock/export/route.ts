import { requirePermission } from "@/lib/auth/guards";
import { listInventoryItemsForExport, type StockStatusFilter, type InventorySort } from "@/lib/queries/inventory";
import { csvResponse } from "@/lib/reports/csv";

/**
 * General Stock CSV export (Batch 3, Task 4) — same permission
 * (`inventory.view`) and the same filters as `/stock`, so a download always
 * matches what's on screen; tenant scope is automatic (the query goes
 * through the tenant-scoped `prisma`, same as the page).
 */
export async function GET(request: Request): Promise<Response> {
  await requirePermission("inventory.view");
  const url = new URL(request.url);
  const stockStatus: StockStatusFilter =
    url.searchParams.get("stockStatus") === "low" || url.searchParams.get("stockStatus") === "out"
      ? (url.searchParams.get("stockStatus") as StockStatusFilter)
      : "all";
  const sort: InventorySort =
    url.searchParams.get("sort") === "quantity-asc" || url.searchParams.get("sort") === "quantity-desc"
      ? (url.searchParams.get("sort") as InventorySort)
      : "recent";

  const rows = await listInventoryItemsForExport({
    q: url.searchParams.get("q") ?? undefined,
    warehouseId: url.searchParams.get("warehouseId") ?? undefined,
    categoryId: url.searchParams.get("categoryId") ?? undefined,
    stockStatus,
    sort,
  });

  return csvResponse(
    "stock",
    ["Produit", "Variante", "Référence", "SKU", "Code-barres", "Catégorie", "Emplacement", "Stock physique", "Réservé", "Disponible", "Endommagé"],
    rows.map((r) => [
      r.productName,
      r.variantLabel,
      r.reference,
      r.sku,
      r.barcode,
      r.categoryName,
      r.warehouseName,
      r.quantityOnHand,
      r.quantityReserved,
      r.available,
      r.quantityDamaged,
    ])
  );
}
