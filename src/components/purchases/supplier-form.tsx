"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { createSupplierAction, updateSupplierAction } from "@/actions/purchases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, FieldRow } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormSection, FormSectionGroup } from "@/components/form-section";

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
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV((p) => ({ ...p, [k]: e.target.value }));

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
          <FormSectionGroup>
            <FormSection title="Identité">
              <Field>
                <Label htmlFor="sup-name" required>
                  Nom / société
                </Label>
                <Input id="sup-name" value={v.name} onChange={set("name")} placeholder="Ex. Atlas Distribution" autoFocus />
              </Field>
            </FormSection>

            <FormSection title="Contact" description="Optionnel — utile pour les relances et confirmations.">
              <FieldRow>
                <Field>
                  <Label htmlFor="sup-phone">Téléphone</Label>
                  <Input id="sup-phone" type="tel" value={v.phone} onChange={set("phone")} placeholder="06 00 00 00 00" />
                </Field>
                <Field>
                  <Label htmlFor="sup-email">E-mail</Label>
                  <Input id="sup-email" type="email" value={v.email} onChange={set("email")} placeholder="contact@fournisseur.ma" />
                </Field>
              </FieldRow>
            </FormSection>

            <FormSection title="Adresse">
              {/* Street address gets the wide column, city the narrow one —
                  one coherent row instead of two equal halves. */}
              <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
                <Field>
                  <Label htmlFor="sup-address">Adresse</Label>
                  <Input id="sup-address" value={v.address} onChange={set("address")} placeholder="Rue, quartier, n°" />
                </Field>
                <Field>
                  <Label htmlFor="sup-city">Ville</Label>
                  <Input id="sup-city" value={v.city} onChange={set("city")} placeholder="Casablanca" />
                </Field>
              </div>
            </FormSection>

            <FormSection title="Notes internes">
              <Textarea
                id="sup-notes"
                aria-label="Notes internes"
                rows={2}
                value={v.notes}
                onChange={set("notes")}
                placeholder="Conditions de paiement, délais, interlocuteur…"
              />
            </FormSection>

            {supplier && (
              <FormSection title="Statut">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={v.isActive} onCheckedChange={(c) => setV((p) => ({ ...p, isActive: c }))} />
                  Fournisseur actif
                </label>
              </FormSection>
            )}
          </FormSectionGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Annuler
            </Button>
            <Button type="button" onClick={save} loading={isPending} disabled={v.name.trim().length < 2}>
              {supplier ? "Enregistrer" : "Créer le fournisseur"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
