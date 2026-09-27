import { requirePermission } from "@/lib/auth/guards";
import { listAccessibleActiveWarehouses, hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { listInventoryItemsForExport, type StockStatusFilter, type InventorySort } from "@/lib/queries/inventory";
import { csvResponse } from "@/lib/reports/csv";

/**
 * General Stock CSV export (Batch 3, Task 4) — same permission
 * (`inventory.view`) and the same filters as `/stock`, so a download always
 * matches what's on screen; tenant scope is automatic (the query goes
 * through the tenant-scoped `prisma`, same as the page).
 *
 * Batch 15: this export had no Location Access Management (docs/adr/0037)
 * scoping at all — a scoped user (or a forged `?warehouseId=`) could
 * download stock for every warehouse in the tenant. Fixed with the same
 * pattern every other location-aware surface already uses.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requirePermission("inventory.view");
  const url = new URL(request.url);
  const stockStatus: StockStatusFilter =
    url.searchParams.get("stockStatus") === "low" || url.searchParams.get("stockStatus") === "out"
      ? (url.searchParams.get("stockStatus") as StockStatusFilter)
      : "all";
  const sort: InventorySort =
    url.searchParams.get("sort") === "quantity-asc" || url.searchParams.get("sort") === "quantity-desc"
      ? (url.searchParams.get("sort") as InventorySort)
      : "recent";

  const isGlobal = hasGlobalLocationAccess(user.role);
  const accessible = isGlobal ? null : await listAccessibleActiveWarehouses(user);
  const requestedWarehouseId = url.searchParams.get("warehouseId") ?? undefined;
  // A requested id outside the caller's own authorized set is simply
  // dropped — never trusted as-is, exactly like /rapports/stock's export.
  const warehouseId =
    isGlobal || accessible!.some((w) => w.id === requestedWarehouseId) ? requestedWarehouseId : undefined;

  const rows = await listInventoryItemsForExport({
    q: url.searchParams.get("q") ?? undefined,
    warehouseId,
    categoryId: url.searchParams.get("categoryId") ?? undefined,
    stockStatus,
    sort,
    allowedWarehouseIds: isGlobal ? null : accessible!.map((w) => w.id),
  });

  return csvResponse(
    "stock",
    [
      "Produit",
      "Variante",
      "Référence",
      "SKU",
      "Code-barres",
      "Catégorie",
      "Emplacement",
      "Stock physique",
      "Réservé",
      "Disponible",
      "Endommagé",
      "Statut",
    ],
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
      r.stockStatus,
    ])
  );
}
