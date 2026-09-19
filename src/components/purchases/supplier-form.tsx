"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { createSupplierAction, updateSupplierAction } from "@/actions/purchases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface SupplierValues {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  notes: string | null;
  isActive: boolean;
}

/** Create (no `supplier`) or edit a supplier — docs/adr/0040. Minimal, business-relevant fields only. */
export function SupplierForm({ supplier }: { supplier?: SupplierValues }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [v, setV] = useState({
    name: supplier?.name ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    address: supplier?.address ?? "",
    city: supplier?.city ?? "",
    notes: supplier?.notes ?? "",
    isActive: supplier?.isActive ?? true,
  });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((p) => ({ ...p, [k]: e.target.value }));

  function save() {
    startTransition(async () => {
      const r = supplier
        ? await updateSupplierAction({ id: supplier.id, ...v })
        : await createSupplierAction(v);
      if (r.ok) {
        toast.success(supplier ? "Fournisseur mis à jour." : "Fournisseur créé.");
        setOpen(false);
        if (!supplier) router.push(`/fournisseurs/${r.data.id}`);
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <>
      <Button type="button" variant={supplier ? "outline" : "default"} onClick={() => setOpen(true)}>
        {supplier ? <Pencil className="size-4" /> : <Plus className="size-4" />}
        {supplier ? "Modifier" : "Nouveau fournisseur"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{supplier ? "Modifier le fournisseur" : "Nouveau fournisseur"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sup-name">Nom / société</Label>
              <Input id="sup-name" value={v.name} onChange={set("name")} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-phone">Téléphone</Label>
              <Input id="sup-phone" value={v.phone} onChange={set("phone")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-email">E-mail</Label>
              <Input id="sup-email" type="email" value={v.email} onChange={set("email")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-city">Ville</Label>
              <Input id="sup-city" value={v.city} onChange={set("city")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sup-address">Adresse</Label>
              <Input id="sup-address" value={v.address} onChange={set("address")} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="sup-notes">Notes</Label>
              <Input id="sup-notes" value={v.notes} onChange={set("notes")} />
            </div>
            {supplier && (
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <Switch checked={v.isActive} onCheckedChange={(c) => setV((p) => ({ ...p, isActive: c }))} />
                Fournisseur actif
              </label>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Annuler
            </Button>
            <Button type="button" onClick={save} disabled={isPending || v.name.trim().length < 2}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
