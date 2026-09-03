import { Warehouse as WarehouseIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WarehouseForm } from "@/components/inventory/warehouse-form";
import { WarehouseRowActions } from "@/components/inventory/warehouse-row-actions";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listWarehousesWithStats } from "@/lib/queries/inventory";
import { WAREHOUSE_TYPE_LABELS, RECORD_SOURCE_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Emplacements — ASODITECH Gestion E-commerce" };

export default async function EntrepotsPage() {
  const user = await requirePermission("inventory.view");
  const canManage = hasPermission(user.role, "warehouses.manage");
  const warehouses = await listWarehousesWithStats();

  return (
    <div>
      <PageHeader
        title="Emplacements"
        description="Entrepôts et magasins où le stock est détenu. Chaque emplacement gère son propre stock par produit."
      />

      {warehouses.length === 0 ? (
        <EmptyState icon={WarehouseIcon} title="Aucun emplacement de stock." />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Adresse</TableHead>
                <TableHead>Articles suivis</TableHead>
                <TableHead>Statut</TableHead>
                {canManage && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {warehouses.map((w) => {
                const isExternal = w.source !== "INTERNE";
                return (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">
                      {w.name}
                      {w.isDefault && (
                        <Badge variant="secondary" className="ml-2">
                          Par défaut
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{WAREHOUSE_TYPE_LABELS[w.type]}</TableCell>
                    <TableCell className="text-muted-foreground">{w.address ?? "—"}</TableCell>
                    <TableCell>{w._count.inventoryItems}</TableCell>
                    <TableCell>
                      <Badge variant={w.isActive ? "default" : "secondary"}>{w.isActive ? "Actif" : "Inactif"}</Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        {isExternal ? (
                          <span className="text-xs text-muted-foreground">
                            Géré via {RECORD_SOURCE_LABELS[w.source] ?? w.source}
                          </span>
                        ) : (
                          <WarehouseRowActions
                            warehouse={{
                              id: w.id,
                              name: w.name,
                              type: w.type,
                              address: w.address,
                              isActive: w.isActive,
                              isDefault: w.isDefault,
                            }}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {canManage && (
        <div className="mt-4">
          <WarehouseForm />
        </div>
      )}
    </div>
  );
}
