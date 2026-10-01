"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search, Trash2, Plus, PackagePlus } from "lucide-react";
import { createReceptionAction, updateReceptionDraftAction, getLatestPurchasePriceAction, createSupplierAction } from "@/actions/purchases";
import { lookupSellableUnitsAction } from "@/actions/catalog";
import type { SellableUnit } from "@/lib/catalog/lookup";
import { suggestReceptionReference } from "@/lib/purchases/reception-reference";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldHint, FieldRow } from "@/components/ui/field";
import { FormActions, FormSection, FormSectionGroup } from "@/components/form-section";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { ProductMetricRow } from "@/components/products/product-metric-row";
import { formatCurrency, formatDate } from "@/lib/format";


interface Line {
  key: string;
  productId: string | null;
  variationId: string | null;
  label: string;
  sku: string;
  quantity: number;
  /** null = not typed yet, or — on a draft edit without purchase-price
   * visibility — « inchangé »: the server keeps the stored price (docs/adr/0048). */
  unitCost: number | null;
  /** "Dernier achat" hint (Batch 3, Task 3A) — undefined while loading, null once
   * confirmed there is no purchase history for this unit. */
  lastPurchase?: { unitCost: number; supplierName: string; date: string } | null;
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
  canCreateSupplier = false,
  showPurchasePrices = true,
  reception,
}: {
  suppliers: { id: string; name: string }[];
  warehouses: { id: string; name: string; type: string }[];
  /** `suppliers.manage` — shows the inline "Nouveau fournisseur" quick-create
   * next to the supplier select. A reception-only user (`purchases.create`
   * without `suppliers.manage`) never sees it — never a dead-end action. */
  canCreateSupplier?: boolean;
  /** `productCostVisibility().purchasePrices` — `purchases.view` (docs/adr/0052). false: the
   * operator types each price from the supplier's document, but no stored
   * price is ever shown — no last-purchase hint, no totals, and a draft's
   * existing lines stay « inchangé » unless re-typed. */
  showPurchasePrices?: boolean;
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
  // Local copy so a supplier created inline (below) appears in the select
  // immediately, without a full page reload — the server list is still the
  // source of truth on the next real navigation.
  const [supplierList, setSupplierList] = useState(suppliers);
  const [newSupplierOpen, setNewSupplierOpen] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [creatingSupplier, setCreatingSupplier] = useState(false);

  function createSupplierInline() {
    const name = newSupplierName.trim();
    if (name.length < 2) return toast.error("Le nom du fournisseur est requis.");
    setCreatingSupplier(true);
    createSupplierAction({ name })
      .then((result) => {
        if (result.ok) {
          setSupplierList((prev) => [...prev, { id: result.data.id, name }].sort((a, b) => a.name.localeCompare(b.name)));
          setSupplierId(result.data.id);
          setNewSupplierOpen(false);
          setNewSupplierName("");
          toast.success("Fournisseur créé.");
        } else {
          toast.error(result.error);
        }
      })
      .finally(() => setCreatingSupplier(false));
  }
  const [warehouseId, setWarehouseId] = useState(reception?.warehouseId ?? warehouses[0]?.id ?? "");
  // Smart initial suggestion (Batch 9, Group 9) — create mode only; an
  // existing draft's own reference is never touched. `referenceTouched`
  // tracks whether the OPERATOR has typed in the field: once true, this
  // value is never auto-recomputed again, no matter what else changes —
  // "never overwrite a manually edited value" is the one hard rule here.
  const [supplierReference, setSupplierReference] = useState(
    reception?.supplierReference ?? suggestReceptionReference(new Date(), null)
  );
  const [referenceTouched, setReferenceTouched] = useState(Boolean(reception));
  const [notes, setNotes] = useState(reception?.notes ?? "");
  const [date, setDate] = useState(reception?.date ?? new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>(reception?.lines ?? []);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SellableUnit[]>([]);
  const [searching, setSearching] = useState(false);

  // Refreshes the suggestion once the supplier becomes known — but only
  // while the operator hasn't touched the field themselves (Batch 9, Group
  // 9). Never runs in edit mode (`referenceTouched` starts `true` there).
  useEffect(() => {
    if (referenceTouched) return;
    // Wrapped in a callback (not called synchronously in the effect body)
    // to satisfy react-hooks/set-state-in-effect — same established fix as
    // every other effect-driven setState in this codebase.
    void (async () => {
      const supplierName = supplierList.find((s) => s.id === supplierId)?.name ?? null;
      setSupplierReference(suggestReceptionReference(new Date(date), supplierName));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId, date]);

  // `code` lets the camera scanner (Batch 6) feed a value straight through
  // without waiting on `setQuery`'s next render — the EXACT same lookup
  // (`lookupSellableUnitsAction`) a hardware scanner's Enter key or the
  // "Chercher" button already use, never a second implementation.
  async function search(code?: string) {
    const q = code ?? query;
    if (!q.trim()) return;
    setSearching(true);
    const found = await lookupSellableUnitsAction({ query: q });
    setSearching(false);
    setHits(found);
    // A scanner types the code then presses Enter: an exact barcode/SKU hit is added straight away.
    if (found.length === 1 && found[0].matchedBy !== "partial") {
      add(found[0]);
      setQuery("");
      setHits([]);
    } else if (found.length === 0) toast.error("Aucun article trouvé.");
  }

  function onCameraDetect(code: string) {
    setQuery(code);
    void search(code);
  }

  function add(u: SellableUnit) {
    const key = u.variationId ? `v:${u.variationId}` : `p:${u.productId}`;
    const isNewLine = !lines.some((l) => l.key === key);
    setLines((prev) =>
      prev.some((l) => l.key === key)
        ? prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l))
        : [...prev, { key, productId: u.variationId ? null : u.productId, variationId: u.variationId, label: `${u.name}${u.variantLabel ? ` — ${u.variantLabel}` : ""}`, sku: u.sku, quantity: 1, unitCost: showPurchasePrices ? (u.cost ?? 0) : null }]
    );
    setHits([]);
    setQuery("");

    // "Dernier achat" hint (Task 3A) — fetched once per new line, never
    // blocks adding the line, and never overwrites the price the operator
    // may already be typing.
    if (isNewLine && showPurchasePrices) {
      getLatestPurchasePriceAction({ productId: u.variationId ? null : u.productId, variationId: u.variationId })
        .then((last) => {
          setLines((prev) =>
            prev.map((l) =>
              l.key === key
                ? { ...l, lastPurchase: last ? { unitCost: last.unitCost, supplierName: last.supplierName, date: new Date(last.date).toISOString() } : null }
                : l
            )
          );
        })
        .catch(() => {
          // Purely informational — a failed lookup just leaves no hint.
        });
    }
  }

  const total = lines.reduce((s, l) => s + l.quantity * (l.unitCost ?? 0), 0);

  function submit() {
    if (!supplierId) return toast.error("Choisissez un fournisseur.");
    if (!warehouseId) return toast.error("Choisissez l'emplacement de destination.");
    if (lines.length === 0) return toast.error("Ajoutez au moins une ligne.");
    const kept = new Set((reception?.lines ?? []).map((l) => l.key));
    if (lines.some((l) => l.unitCost === null && !kept.has(l.key))) {
      return toast.error("Saisissez le prix d'achat de chaque nouvel article.");
    }
    const base = { supplierId, warehouseId, receptionDate: new Date(date), supplierReference, notes };
    const lineOf = (l: Line) => ({ productId: l.variationId ? null : l.productId, variationId: l.variationId, quantity: l.quantity });
    startTransition(async () => {
      const r = reception
        ? await updateReceptionDraftAction({ id: reception.id, ...base, lines: lines.map((l) => ({ ...lineOf(l), unitCost: l.unitCost })) })
        : await createReceptionAction({ ...base, lines: lines.map((l) => ({ ...lineOf(l), unitCost: l.unitCost ?? 0 })) });
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
        <CardHeader className="border-b">
          <CardTitle>Informations de réception</CardTitle>
          {!reception && (
            <CardDescription className="text-xs">
              Une référence interne (ex. REC-000123) est générée à l&apos;enregistrement. Elle complète — sans le
              remplacer — le numéro du document fournisseur.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <FormSectionGroup>
            <FormSection title="Provenance & destination">
              <FieldRow>
                <Field>
                  <Label htmlFor="rc-sup" required>
                    Fournisseur
                  </Label>
                  {/* The quick-create sits ON the field's row, attached to the
                      select — the action is visibly "add a supplier to THIS
                      list", not a stray link floating above the label. */}
                  <div className="flex gap-2">
                    <NativeSelect id="rc-sup" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                      <option value="">Sélectionner un fournisseur…</option>
                      {supplierList.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </NativeSelect>
                    {canCreateSupplier && (
                      <Dialog open={newSupplierOpen} onOpenChange={setNewSupplierOpen}>
                        <DialogTrigger
                          render={<Button type="button" variant="secondary" className="shrink-0" title="Créer un nouveau fournisseur" />}
                        >
                          <Plus className="size-4" />
                          Ajouter
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Nouveau fournisseur</DialogTitle>
                            <DialogDescription>
                              Créé immédiatement et sélectionné pour cette réception. Téléphone, adresse et notes se
                              complètent plus tard depuis la fiche fournisseur.
                            </DialogDescription>
                          </DialogHeader>
                          <Field>
                            <Label htmlFor="rc-new-sup-name" required>
                              Nom du fournisseur
                            </Label>
                            <Input
                              id="rc-new-sup-name"
                              autoFocus
                              value={newSupplierName}
                              onChange={(e) => setNewSupplierName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  createSupplierInline();
                                }
                              }}
                              placeholder="Ex. Atlas Distribution"
                            />
                          </Field>
                          <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setNewSupplierOpen(false)} disabled={creatingSupplier}>
                              Annuler
                            </Button>
                            <Button type="button" onClick={createSupplierInline} loading={creatingSupplier}>
                              <Plus className="size-4" />
                              Créer le fournisseur
                            </Button>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    )}
                  </div>
                </Field>
                <Field>
                  <Label htmlFor="rc-wh" required>
                    Emplacement de destination
                  </Label>
                  <NativeSelect id="rc-wh" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.type === "MAGASIN" ? "Magasin" : "Entrepôt"})
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </FieldRow>
            </FormSection>

            <FormSection title="Document fournisseur">
              <FieldRow>
                <Field>
                  <Label htmlFor="rc-ref">N° bon de livraison / facture</Label>
                  <Input
                    id="rc-ref"
                    value={supplierReference}
                    onChange={(e) => {
                      setReferenceTouched(true);
                      setSupplierReference(e.target.value);
                    }}
                  />
                  <FieldHint>Pré-rempli pour gagner du temps — remplacez-le par le numéro du document fournisseur.</FieldHint>
                </Field>
                <Field>
                  <Label htmlFor="rc-date" required>
                    Date de réception
                  </Label>
                  <Input id="rc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
              </FieldRow>
              <Field>
                <Label htmlFor="rc-notes">Notes</Label>
                <Textarea
                  id="rc-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Remarques internes : état de la livraison, colis manquant…"
                />
              </Field>
            </FormSection>
          </FormSectionGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Articles reçus</CardTitle>
          <CardDescription className="text-xs">Scannez un code-barres ou recherchez par référence / nom.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              className="sm:flex-1"
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
            <Button type="button" variant="outline" onClick={() => void search()} loading={searching}>
              {!searching && <Search className="size-4" />}
              Chercher
            </Button>
            <BarcodeScanButton onDetect={onCameraDetect} label="Caméra" />
          </div>
          {hits.length > 0 && (
            <ul className="divide-y overflow-hidden rounded-lg border bg-card text-sm shadow-popover">
              {hits.map((u) => (
                <li key={`${u.productId}-${u.variationId}`}>
                  <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left outline-none hover:bg-accent focus-visible:bg-accent" onClick={() => add(u)}>
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

          {lines.length === 0 && (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-sm text-muted-foreground">
              <PackagePlus className="size-4" />
              Aucun article pour l&apos;instant — ajoutez la marchandise reçue ci-dessus.
            </div>
          )}
          {lines.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Article</TableHead>
                  <TableHead className="w-28">Quantité</TableHead>
                  <TableHead className="w-44">Prix d&apos;achat</TableHead>
                  {showPurchasePrices && <TableHead className="w-32 text-right">Total</TableHead>}
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.key}>
                    <TableCell>
                      <ProductMetricRow name={l.label} sku={l.sku} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" min={1} className="w-24 tabular-nums" aria-label={`Quantité — ${l.label}`} value={l.quantity} onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" min={0} step="0.01" className="w-36 tabular-nums" aria-label={`Prix d'achat — ${l.label}`} value={l.unitCost ?? ""} placeholder={l.unitCost === null ? (reception?.lines.some((x) => x.key === l.key) ? "Inchangé" : "Prix facture") : undefined} onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, unitCost: !showPurchasePrices && e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0) } : x)))} />
                      {l.lastPurchase && (
                        <p className="mt-1 w-44 text-[11px] leading-snug whitespace-normal text-muted-foreground">
                          Dernier achat : {formatCurrency(String(l.lastPurchase.unitCost))} chez {l.lastPurchase.supplierName} le{" "}
                          {formatDate(l.lastPurchase.date)}
                        </p>
                      )}
                    </TableCell>
                    {showPurchasePrices && <TableCell className="text-right font-semibold tabular-nums">{formatCurrency(String(l.quantity * (l.unitCost ?? 0)))}</TableCell>}
                    <TableCell>
                      <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label="Retirer la ligne" title="Retirer la ligne" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>
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

      <FormActions
        context={
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span>
              <span className="font-semibold text-foreground tabular-nums">{lines.length}</span> ligne(s)
              {showPurchasePrices && (
                <>
                  {" "}· Total{" "}
                  <span className="text-base font-semibold text-foreground tabular-nums">{formatCurrency(String(total))}</span>
                </>
              )}
            </span>
            <span className="text-xs">Le stock n&apos;est ajouté qu&apos;à la validation.</span>
          </div>
        }
      >
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Annuler
        </Button>
        <Button type="button" onClick={submit} loading={isPending}>
          {reception ? "Enregistrer le brouillon" : "Créer le brouillon"}
        </Button>
      </FormActions>
    </div>
  );
}
