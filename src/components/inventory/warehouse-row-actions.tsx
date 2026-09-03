"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Power } from "lucide-react";
import { updateWarehouseAction, setWarehouseActiveAction } from "@/actions/warehouses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { WAREHOUSE_TYPE_LABELS } from "@/lib/status-labels";
import type { ActionResult, IdResult } from "@/actions/types";

export interface WarehouseRow {
  id: string;
  name: string;
  type: "ENTREPOT" | "MAGASIN";
  address: string | null;
  isActive: boolean;
  isDefault: boolean;
}

export function WarehouseRowActions({ warehouse }: { warehouse: WarehouseRow }) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [editState, editAction, editPending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await updateWarehouseAction(formData);
      if (result.ok) {
        toast.success("Emplacement mis à jour.");
        setEditOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  const [toggleState, toggleAction, togglePending] = useActionState(
    async (_prev: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await setWarehouseActiveAction(formData);
      if (result.ok) {
        toast.success(warehouse.isActive ? "Emplacement désactivé." : "Emplacement réactivé.");
        setConfirmOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <div className="flex items-center justify-end gap-2">
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
          <Pencil className="size-4" />
          Modifier
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modifier l&apos;emplacement</DialogTitle>
          </DialogHeader>
          <form action={editAction} className="space-y-4">
            <input type="hidden" name="id" value={warehouse.id} />
            <div className="space-y-1.5">
              <Label htmlFor={`wh-name-${warehouse.id}`}>Nom</Label>
              <Input id={`wh-name-${warehouse.id}`} name="name" defaultValue={warehouse.name} required autoComplete="off" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`wh-type-${warehouse.id}`}>Type</Label>
              <Select name="type" defaultValue={warehouse.type}>
                <SelectTrigger id={`wh-type-${warehouse.id}`} className="w-full">
                  <SelectValue>{(value: string) => WAREHOUSE_TYPE_LABELS[value] ?? value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(WAREHOUSE_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`wh-address-${warehouse.id}`}>Adresse (optionnel)</Label>
              <Input
                id={`wh-address-${warehouse.id}`}
                name="address"
                defaultValue={warehouse.address ?? ""}
                autoComplete="off"
              />
            </div>
            {editState && !editState.ok && <p className="text-sm text-destructive">{editState.error}</p>}
            <DialogFooter>
              <Button type="submit" disabled={editPending}>
                {editPending ? "Enregistrement..." : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {!warehouse.isDefault && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
            <Power className="size-4" />
            {warehouse.isActive ? "Désactiver" : "Réactiver"}
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {warehouse.isActive ? "Désactiver" : "Réactiver"} « {warehouse.name} » ?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {warehouse.isActive
                  ? "L'emplacement ne pourra plus recevoir de nouveaux mouvements de stock. Son stock actuel et son historique sont conservés."
                  : "L'emplacement pourra de nouveau recevoir des mouvements de stock."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <form action={toggleAction}>
              <input type="hidden" name="id" value={warehouse.id} />
              <input type="hidden" name="isActive" value={warehouse.isActive ? "false" : "true"} />
              {toggleState && !toggleState.ok && (
                <p className="mb-3 text-sm text-destructive">{toggleState.error}</p>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
                <AlertDialogAction type="submit" disabled={togglePending}>
                  {togglePending ? "En cours..." : "Confirmer"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
