"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MapPin } from "lucide-react";
import { setUserLocationsAction } from "@/actions/users";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Label } from "@/components/ui/label";
import type { WarehouseType } from "@prisma/client";

const WAREHOUSE_TYPE_LABELS: Record<WarehouseType, string> = {
  ENTREPOT: "Entrepôt",
  MAGASIN: "Magasin",
};

/**
 * Location Access Management v1 (docs/adr/0037-location-access-management.md).
 * Lets an OWNER/ADMIN (the only roles holding `users.manage`) assign a
 * non-admin user to one or more active warehouses — the ENTIRE authorization
 * for that user's warehouse-scoped actions (inventory adjustments,
 * transfers, stocktakes, order fulfilment, physical returns). Zero
 * warehouses selected means zero access — never "all warehouses".
 */
export function UserLocationsDialog({
  userId,
  name,
  warehouses,
  assignedWarehouseIds,
}: {
  userId: string;
  name: string;
  warehouses: { id: string; name: string; type: WarehouseType }[];
  assignedWarehouseIds: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set(assignedWarehouseIds));

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      const result = await setUserLocationsAction({ userId, warehouseIds: [...selected] });
      if (result.ok) {
        toast.success("Emplacements mis à jour.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => {
          setSelected(new Set(assignedWarehouseIds));
          setOpen(true);
        }}
        title="Gérer les emplacements"
      >
        <MapPin className="size-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Emplacements — {name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Cet utilisateur ne pourra opérer (stock, transferts, inventaires, préparation de commandes, retours) que
            sur les emplacements cochés ci-dessous. Aucun emplacement coché = aucun accès.
          </p>
          {warehouses.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun emplacement actif dans ce tenant.</p>
          ) : (
            <ScrollArea className="max-h-72">
              <div className="space-y-2 pr-3">
                {warehouses.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                    <Checkbox
                      checked={selected.has(w.id)}
                      onCheckedChange={(checked) => toggle(w.id, checked === true)}
                    />
                    <span className="flex-1">{w.name}</span>
                    <Label className="text-xs font-normal text-muted-foreground">
                      {WAREHOUSE_TYPE_LABELS[w.type]}
                    </Label>
                  </label>
                ))}
              </div>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Annuler
            </Button>
            <Button type="button" onClick={save} disabled={isPending}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
