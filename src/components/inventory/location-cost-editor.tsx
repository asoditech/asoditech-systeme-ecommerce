"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { updateLocationCostAction } from "@/actions/inventory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/format";
import { LOCATION_COST_LABELS } from "@/lib/catalog/location-cost-labels";

/**
 * Small dialog to set or clear ONE location's current purchase cost
 * (InventoryItem.currentUnitCost). « Utiliser le coût global » clears it.
 * Rendered only for `finance.view` users; the server action re-checks
 * permission and location access. Never touches a selling price or the
 * global product cost.
 */
export function LocationCostEditor({
  inventoryItemId,
  locationName,
  itemLabel,
  locationCost,
  globalCost,
}: {
  inventoryItemId: string;
  locationName: string;
  itemLabel: string;
  /** This location's own cost, or null when it uses the global cost. */
  locationCost: string | null;
  /** The variation/product global cost it falls back to (null = none). */
  globalCost: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(locationCost ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function openDialog() {
    setValue(locationCost ?? "");
    setError(null);
    setOpen(true);
  }

  function submit(cost: number | null) {
    startTransition(async () => {
      const r = await updateLocationCostAction({ inventoryItemId, cost });
      if (r.ok) {
        toast.success(cost === null ? `${locationName} : ${LOCATION_COST_LABELS.usesGlobal.toLowerCase()}.` : `Coût d'achat de ${locationName} enregistré.`);
        setOpen(false);
        router.refresh();
      } else {
        setError(r.error);
      }
    });
  }

  function save() {
    const n = Number(value.replace(",", "."));
    if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
      setError("Saisissez un coût positif ou nul, ou choisissez « Utiliser le coût global ».");
      return;
    }
    submit(n);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Modifier le coût d'achat de ${locationName}`}
        title="Modifier le coût d'achat de cet emplacement"
        onClick={openDialog}
      >
        <Pencil className="size-3.5" />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Coût d&apos;achat — {locationName}</DialogTitle>
          <DialogDescription>
            {itemLabel}. Coût d&apos;achat utilisé pour les nouvelles ventes depuis cet emplacement et pour la valeur de
            son stock. Ce n&apos;est pas un prix de vente.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="rounded-lg border bg-muted/30 px-3 py-2">
            {LOCATION_COST_LABELS.global} :{" "}
            <span className="font-medium tabular-nums">{globalCost !== null ? formatCurrency(globalCost) : LOCATION_COST_LABELS.missing}</span>
            <span className="block text-xs text-muted-foreground">
              {locationCost === null ? `Actuellement : ${LOCATION_COST_LABELS.usesGlobal.toLowerCase()}.` : "Utilisé si le coût de cet emplacement est retiré."}
            </span>
          </p>
          <div className="space-y-1.5">
            <Label htmlFor={`loc-cost-${inventoryItemId}`}>{LOCATION_COST_LABELS.location} (MAD)</Label>
            <Input
              id={`loc-cost-${inventoryItemId}`}
              inputMode="decimal"
              value={value}
              disabled={pending}
              onChange={(e) => setValue(e.target.value)}
              placeholder={globalCost ?? "0,00"}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Les ventes, mouvements et transferts déjà enregistrés gardent leur coût.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          {locationCost !== null && (
            <Button type="button" variant="outline" disabled={pending} onClick={() => submit(null)} className="sm:mr-auto">
              Utiliser le coût global
            </Button>
          )}
          <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
            Annuler
          </Button>
          <Button type="button" disabled={pending} onClick={save}>
            {pending ? "Enregistrement..." : "Enregistrer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
