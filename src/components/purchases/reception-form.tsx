"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, Trash2 } from "lucide-react";
import { createReceptionAction, updateReceptionDraftAction } from "@/actions/purchases";
import { lookupSellableUnitsAction } from "@/actions/catalog";
import type { SellableUnit } from "@/lib/catalog/lookup";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCurrency } from "@/lib/format";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

interface Line {
  key: string;
  productId: string | null;
  variationId: string | null;
  label: string;
  sku: string;
  quantity: number;
  unitCost: number;
}

/**
 * Purchase reception (docs/adr/0040): supplier, destination location, lines
 * (product OR variation — scan a barcode or type a reference/name), quantity
 * and purchase price. Saving creates a DRAFT — stock is added only when the
 * reception is VALIDATED, through the canonical inventory movement.
 */
export function ReceptionForm({
  suppliers,
  warehouses,
  reception,
}: {
  suppliers: { id: string; name: string }[];
  warehouses: { id: string; name: string; type: string }[];
  reception?: {
    id: string;
    supplierId: string;
    warehouseId: string;
    supplierReference: string;
    notes: string;
    date: string;
    lines: Line[];
  };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [supplierId, setSupplierId] = useState(reception?.supplierId ?? "");
  const [warehouseId, setWarehouseId] = useState(reception?.warehouseId ?? warehouses[0]?.id ?? "");
  const [supplierReference, setSupplierReference] = useState(reception?.supplierReference ?? "");
  const [notes, setNotes] = useState(reception?.notes ?? "");
  const [date, setDate] = useState(reception?.date ?? new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>(reception?.lines ?? []);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SellableUnit[]>([]);
  const [searching, setSearching] = useState(false);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    const found = await lookupSellableUnitsAction({ query });
    setSearching(false);
    setHits(found);
    // A scanner types the code then presses Enter: an exact barcode/SKU hit is added straight away.
    if (found.length === 1 && found[0].matchedBy !== "partial") {
      add(found[0]);
      setQuery("");
      setHits([]);
    } else if (found.length === 0) toast.error("Aucun article trouvé.");
  }

  function add(u: SellableUnit) {
    const key = u.variationId ? `v:${u.variationId}` : `p:${u.productId}`;
    setLines((prev) =>
      prev.some((l) => l.key === key)
        ? prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l))
        : [...prev, { key, productId: u.variationId ? null : u.productId, variationId: u.variationId, label: `${u.name}${u.variantLabel ? ` — ${u.variantLabel}` : ""}`, sku: u.sku, quantity: 1, unitCost: u.cost ?? 0 }]
    );
    setHits([]);
    setQuery("");
  }

  const total = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);

  function submit() {
    if (!supplierId) return toast.error("Choisissez un fournisseur.");
    if (!warehouseId) return toast.error("Choisissez l'emplacement de destination.");
    if (lines.length === 0) return toast.error("Ajoutez au moins une ligne.");
    const payload = {
      supplierId,
      warehouseId,
      receptionDate: new Date(date),
      supplierReference,
      notes,
      lines: lines.map((l) => ({ productId: l.variationId ? null : l.productId, variationId: l.variationId, quantity: l.quantity, unitCost: l.unitCost })),
    };
    startTransition(async () => {
      const r = reception ? await updateReceptionDraftAction({ id: reception.id, ...payload }) : await createReceptionAction(payload);
      if (r.ok) {
        toast.success(reception ? "Brouillon mis à jour." : "Brouillon enregistré.");
        router.push(`/receptions/${r.data.id}`);
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Réception</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="rc-sup">Fournisseur</Label>
            <select id="rc-sup" className={selectClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">— Choisir —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-wh">Emplacement de destination</Label>
            <select id="rc-wh" className={selectClass} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.type === "MAGASIN" ? "Magasin" : "Entrepôt"})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-date">Date de réception</Label>
            <Input id="rc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="rc-ref">N° bon de livraison / facture fournisseur</Label>
            <Input id="rc-ref" value={supplierReference} onChange={(e) => setSupplierReference(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="rc-notes">Notes</Label>
            <Input id="rc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Articles reçus</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex max-w-xl gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Scanner un code-barres, ou saisir référence / nom…"
              aria-label="Rechercher un article"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void search();
                }
              }}
            />
            <Button type="button" variant="outline" onClick={search} disabled={searching}>
              <Search className="size-4" />
              Chercher
            </Button>
          </div>
          {hits.length > 0 && (
            <ul className="max-w-xl divide-y rounded-md border text-sm">
              {hits.map((u) => (
                <li key={`${u.productId}-${u.variationId}`}>
                  <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50" onClick={() => add(u)}>
                    <span>
                      {u.name}
                      {u.variantLabel && <span className="text-muted-foreground"> — {u.variantLabel}</span>}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{u.primaryBarcode ?? u.sku}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article</TableHead>
                  <TableHead className="w-28">Quantité</TableHead>
                  <TableHead className="w-36">Prix d&apos;achat</TableHead>
                  <TableHead className="w-32 text-right">Total</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.key}>
                    <TableCell>
                      <div className="font-medium">{l.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">{l.sku}</div>
                    </TableCell>
                    <TableCell>
                      <Input type="number" min={1} value={l.quantity} onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" min={0} step="0.01" value={l.unitCost} onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, unitCost: Math.max(0, Number(e.target.value) || 0) } : x)))} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(String(l.quantity * l.unitCost))}</TableCell>
                    <TableCell>
                      <Button type="button" variant="ghost" size="icon" aria-label="Retirer la ligne" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex items-center justify-between border-t pt-3">
            <span className="text-sm text-muted-foreground">Le stock n&apos;est ajouté qu&apos;à la validation de la réception.</span>
            <span className="text-lg font-semibold tabular-nums">{formatCurrency(String(total))}</span>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Annuler
        </Button>
        <Button type="button" onClick={submit} disabled={isPending}>
          {isPending ? "Enregistrement..." : reception ? "Enregistrer le brouillon" : "Créer le brouillon"}
        </Button>
      </div>
    </div>
  );
}
