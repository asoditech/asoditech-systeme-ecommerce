"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createStocktakeSessionAction } from "@/actions/stocktakes";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WAREHOUSE_TYPE_LABELS } from "@/lib/status-labels";

interface WarehouseOption {
  id: string;
  name: string;
  type: "ENTREPOT" | "MAGASIN";
}

export function StocktakeForm({ warehouses }: { warehouses: WarehouseOption[] }) {
  const router = useRouter();
  const [warehouseId, setWarehouseId] = React.useState(warehouses[0]?.id ?? "");
  const [notes, setNotes] = React.useState("");
  const [isPending, startTransition] = React.useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!warehouseId) {
      toast.error("Sélectionnez un entrepôt.");
      return;
    }
    startTransition(async () => {
      const result = await createStocktakeSessionAction({ warehouseId, notes });
      if (result.ok) {
        toast.success("Inventaire démarré.");
        router.push(`/inventaires/${result.data.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Nouvel inventaire</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Entrepôt</Label>
            {warehouses.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun entrepôt actif disponible.</p>
            ) : (
              <Select value={warehouseId} onValueChange={(v) => v && setWarehouseId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choisir un entrepôt" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} ({WAREHOUSE_TYPE_LABELS[w.type]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              Toutes les fiches de stock de cet entrepôt seront figées comme référence de comptage.
              Le stock réel n&apos;est pas modifié.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optionnel)</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Annuler
        </Button>
        <Button type="submit" disabled={isPending || warehouses.length === 0}>
          {isPending ? "Démarrage..." : "Démarrer l'inventaire"}
        </Button>
      </div>
    </form>
  );
}
