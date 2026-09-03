"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";
import {
  createStockTransferAction,
  updateStockTransferDraftAction,
  listSourceStockAction,
} from "@/actions/transfers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { WAREHOUSE_TYPE_LABELS } from "@/lib/status-labels";

interface WarehouseOption {
  id: string;
  name: string;
  type: "ENTREPOT" | "MAGASIN";
}

type StockRow = Awaited<ReturnType<typeof listSourceStockAction>>[number];

interface DraftLine {
  key: string;
  productId: string | null;
  variationId: string | null;
  label: string;
  sku: string;
  quantitySent: number;
  maxOnHand: number | null;
}

export interface TransferFormProps {
  warehouses: WarehouseOption[];
  mode?: "create" | "edit";
  transfer?: {
    id: string;
    sourceWarehouseId: string;
    sourceName: string;
    destinationWarehouseId: string;
    destinationName: string;
    notes: string;
    lines: { productId: string | null; variationId: string | null; label: string; sku: string; quantitySent: number }[];
  };
}

const refKey = (r: { productId: string | null; variationId: string | null }) =>
  r.variationId ? `v:${r.variationId}` : `p:${r.productId}`;

export function TransferForm({ warehouses, mode = "create", transfer }: TransferFormProps) {
  const router = useRouter();
  const isEdit = mode === "edit" && transfer;

  const [sourceId, setSourceId] = React.useState(transfer?.sourceWarehouseId ?? "");
  const [destId, setDestId] = React.useState(transfer?.destinationWarehouseId ?? "");
  const [notes, setNotes] = React.useState(transfer?.notes ?? "");
  const [stock, setStock] = React.useState<StockRow[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  const [lines, setLines] = React.useState<DraftLine[]>(
    transfer?.lines.map((l, i) => ({
      key: `${refKey(l)}-${i}`,
      productId: l.productId,
      variationId: l.variationId,
      label: l.label,
      sku: l.sku,
      quantitySent: l.quantitySent,
      maxOnHand: null,
    })) ?? []
  );

  // Load the source warehouse's on-hand stock whenever it changes.
  // `listSourceStockAction("")` returns `[]`, so an empty source clears the list.
  React.useEffect(() => {
    let cancelled = false;
    listSourceStockAction(sourceId).then((rows) => {
      if (!cancelled) setStock(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  const usedRefs = new Set(lines.map(refKey));
  const availableStock = stock.filter((s) => !usedRefs.has(refKey(s)));

  function addLine(row: StockRow) {
    setLines((prev) => [
      ...prev,
      {
        key: `${refKey(row)}-${Date.now()}`,
        productId: row.productId,
        variationId: row.variationId,
        label: row.label,
        sku: row.sku,
        quantitySent: 1,
        maxOnHand: row.quantityOnHand,
      },
    ]);
    setPickerOpen(false);
  }

  function updateLine(key: string, quantitySent: number) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, quantitySent } : l)));
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isEdit) {
      if (!sourceId || !destId) return toast.error("Sélectionnez la source et la destination.");
      if (sourceId === destId) return toast.error("La source et la destination doivent être différentes.");
    }
    if (lines.length === 0) return toast.error("Ajoutez au moins une ligne.");
    if (lines.some((l) => l.quantitySent < 1)) return toast.error("Chaque ligne doit avoir une quantité d'au moins 1.");

    const payloadLines = lines.map((l) => ({
      productId: l.variationId ? null : l.productId,
      variationId: l.variationId,
      quantitySent: l.quantitySent,
    }));

    startTransition(async () => {
      const result = isEdit
        ? await updateStockTransferDraftAction({ id: transfer!.id, notes, lines: payloadLines })
        : await createStockTransferAction({
            sourceWarehouseId: sourceId,
            destinationWarehouseId: destId,
            notes,
            lines: payloadLines,
          });

      if (result.ok) {
        toast.success(isEdit ? "Transfert mis à jour." : "Transfert créé.");
        router.push(`/transferts/${result.data.id}`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const activeWarehouses = warehouses;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Emplacements</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Source</Label>
            {isEdit ? (
              <Input value={transfer!.sourceName} disabled />
            ) : (
              <Select value={sourceId} onValueChange={(v) => v && setSourceId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choisir un entrepôt source" />
                </SelectTrigger>
                <SelectContent>
                  {activeWarehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} ({WAREHOUSE_TYPE_LABELS[w.type]})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Destination</Label>
            {isEdit ? (
              <Input value={transfer!.destinationName} disabled />
            ) : (
              <Select value={destId} onValueChange={(v) => v && setDestId(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choisir une destination" />
                </SelectTrigger>
                <SelectContent>
                  {activeWarehouses
                    .filter((w) => w.id !== sourceId)
                    .map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name} ({WAREHOUSE_TYPE_LABELS[w.type]})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Articles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger
              render={<Button type="button" variant="outline" disabled={!sourceId} />}
            >
              <Plus className="size-4" />
              Ajouter un article
            </PopoverTrigger>
            <PopoverContent align="start" className="w-96 p-2">
              <div className="max-h-64 overflow-y-auto">
                {availableStock.length === 0 ? (
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    Aucun stock disponible à cet emplacement.
                  </p>
                ) : (
                  availableStock.map((s) => (
                    <button
                      key={refKey(s)}
                      type="button"
                      onClick={() => addLine(s)}
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="font-medium">{s.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.sku} · {s.quantityOnHand} en stock
                      </span>
                    </button>
                  ))
                )}
              </div>
            </PopoverContent>
          </Popover>

          {lines.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article</TableHead>
                  <TableHead>Quantité à envoyer</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.key}>
                    <TableCell>
                      <p className="font-medium">{l.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {l.sku}
                        {l.maxOnHand != null ? ` · ${l.maxOnHand} en stock` : ""}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min="1"
                        className="w-24"
                        value={l.quantitySent}
                        onChange={(e) => updateLine(l.key, Math.max(1, Number(e.target.value)))}
                      />
                    </TableCell>
                    <TableCell>
                      <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeLine(l.key)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Annuler
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Enregistrement..." : isEdit ? "Enregistrer" : "Créer le transfert"}
        </Button>
      </div>
    </form>
  );
}
