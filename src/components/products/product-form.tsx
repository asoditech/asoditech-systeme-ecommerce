"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createProductAction, updateProductAction, createCategoryAction } from "@/actions/products";
import { productCreateRedirectPath } from "@/lib/catalog/variations";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { gs1CheckDigitWarning } from "@/lib/catalog/gs1";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldHint } from "@/components/ui/field";
import { FormActions, FormSection, FormSectionGroup } from "@/components/form-section";
import { ProductThumb } from "@/components/products/product-thumb";
import { Globe, Plus, Store } from "lucide-react";
import { cn } from "@/lib/utils";
import { PRODUCT_STATUS_LABELS } from "@/lib/status-labels";
import type { Product, Category } from "@prisma/client";
import type { ActionResult, IdResult } from "@/actions/types";

// Prisma's Decimal fields aren't serializable across the Server->Client
// boundary — pages pass a plain-string version (see produits/[id]/page.tsx).
export type SerializedProduct = Omit<Product, "price" | "salePrice" | "cost"> & {
  price: string;
  salePrice: string | null;
  cost: string | null;
};

export interface ProductFormChannel {
  id: string;
  name: string;
  kind: "ONLINE" | "OFFLINE";
  isDefault: boolean;
}

export function ProductForm({
  product,
  categories: initialCategories,
  channels = [],
  identityEnabled = false,
  defaultLowStockThreshold = 5,
  canEditCost,
}: {
  product?: SerializedProduct;
  categories: Category[];
  /** Create mode only — where the new product may be sold (docs/adr/0038). Empty in an ONLINE_ONLY tenant. */
  channels?: ProductFormChannel[];
  /**
   * The `catalogIdentity` capability (docs/adr/0041): model reference, barcode
   * and inline category creation. OFF for an ONLINE_ONLY tenant, whose product
   * form is exactly the pre-existing one.
   */
  identityEnabled?: boolean;
  /**
   * Create mode only (Batch 17) — the tenant's own "Seuil de stock faible
   * par défaut" (`BusinessSettings.lowStockDefaultThreshold`). Previously
   * hardcoded to `5` here regardless of that setting, so changing it in
   * Paramètres had no effect on any product created afterward — the one
   * thing the setting's own label promises. An existing product keeps its
   * own saved threshold, unaffected.
   */
  defaultLowStockThreshold?: number;
  /**
   * `finance.view` (Phase 4B): without it the purchase cost field is not
   * rendered — so never submitted — and the server ignores a cost from this
   * user anyway (a create stores none, an update leaves it unchanged).
   */
  canEditCost: boolean;
}) {
  const router = useRouter();
  // Categories are real, tenant-scoped entities (docs/adr/0038 §Categories):
  // a new one can be created inline without leaving the product form.
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [categoryId, setCategoryId] = useState<string>(product?.categoryId ?? "");
  const [newCategory, setNewCategory] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  // Create mode only (Batch 3, Task 2) — edit already has its own image card
  // (ProductImageForm) once the product exists.
  const [imagePreview, setImagePreview] = useState("");
  // "Ce produit possède des variantes" (Batch 9, Group 3) — create mode only.
  // Variations still require an existing productId (the architecture is
  // unchanged), so this doesn't create variants inline; it just makes the
  // create → define-variants flow continuous by landing the operator
  // straight on the Variations tab, generator already open, right after
  // the product itself is created.
  const [hasVariants, setHasVariants] = useState(false);
  // Controlled so the camera scanner (Batch 11) can fill it, same pattern as
  // the identity panel's barcode fields — a hardware scanner or manual typing
  // keeps working unchanged either way.
  const [barcode, setBarcode] = useState("");
  const [checkedChannels, setCheckedChannels] = useState<Set<string>>(
    new Set(channels.filter((c) => c.isDefault).map((c) => c.id))
  );

  async function handleCreateCategory() {
    const name = newCategory.trim();
    if (name.length < 2) return toast.error("Le nom de la catégorie est requis (2 caractères minimum).");
    setCreatingCategory(true);
    const fd = new FormData();
    fd.set("name", name);
    const result = await createCategoryAction(fd);
    setCreatingCategory(false);
    if (result.ok) {
      setCategories((prev) => [...prev, result.data].sort((a, b) => a.name.localeCompare(b.name)));
      setCategoryId(result.data.id);
      setNewCategory("");
      setNewCategoryOpen(false);
      toast.success("Catégorie créée.");
    } else {
      toast.error(result.error);
    }
  }

  const action = product ? updateProductAction : createProductAction;
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => action(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(product ? "Produit mis à jour." : "Produit créé.");
      router.push(productCreateRedirectPath(state.data.id, !product && hasVariants));
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const identityCodes = !product && identityEnabled;
  const skuField = (
    <Field>
      <Label htmlFor="sku" required>
        SKU
      </Label>
      <Input
        id="sku"
        name="sku"
        required
        defaultValue={product?.sku}
        className="font-mono"
        aria-invalid={Boolean(state && !state.ok && state.fieldErrors?.sku) || undefined}
      />
      <FieldError>{state && !state.ok ? state.fieldErrors?.sku?.[0] : undefined}</FieldError>
    </Field>
  );

  return (
    <form action={formAction} className="space-y-4">
      {product && <input type="hidden" name="id" value={product.id} />}
      <Card>
        <CardContent>
          <FormSectionGroup>
            <FormSection title="Identité">
              <Field>
                <Label htmlFor="name" required>
                  Nom du produit
                </Label>
                <Input id="name" name="name" required defaultValue={product?.name} placeholder="Ex. T-shirt coton col rond" />
              </Field>
              {/* Classification (catégorie + statut) and codes (SKU,
                  référence, code-barres) each read as one coherent row.
                  Without the identity fields, SKU joins the classification
                  row instead of sitting alone. */}
              <div className={cn("grid gap-4", identityCodes ? "sm:grid-cols-2" : "sm:grid-cols-3")}>
                {!identityCodes && skuField}
                {renderCategoryField()}
                <Field>
                  <Label htmlFor="status">Statut</Label>
                  <Select name="status" defaultValue={product?.status ?? "BROUILLON"}>
                    <SelectTrigger id="status" className="w-full">
                      <SelectValue>{(value: string) => PRODUCT_STATUS_LABELS[value]?.label ?? value}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PRODUCT_STATUS_LABELS).map(([value, meta]) => (
                        <SelectItem key={value} value={value}>
                          {meta.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {identityCodes && (
                <div className="grid gap-4 sm:grid-cols-3">
                  {skuField}
                  <Field>
                    <Label htmlFor="reference">Référence du modèle</Label>
                    <Input id="reference" name="reference" placeholder="Ex. SKOUBA" />
                  </Field>
                  <Field>
                    <Label htmlFor="barcode">Code-barres</Label>
                    <div className="flex gap-2">
                      <Input
                        id="barcode"
                        name="barcode"
                        placeholder="Scanner ou saisir"
                        autoComplete="off"
                        value={barcode}
                        onChange={(e) => setBarcode(e.target.value)}
                        className="flex-1 font-mono"
                        aria-invalid={Boolean(state && !state.ok && state.fieldErrors?.barcode) || undefined}
                      />
                      <BarcodeScanButton onDetect={setBarcode} label="" />
                    </div>
                    <FieldError>{state && !state.ok ? state.fieldErrors?.barcode?.[0] : undefined}</FieldError>
                    {/* Non-blocking: a numeric code of a GTIN length is not necessarily a GTIN. */}
                    {gs1CheckDigitWarning(barcode) && (
                      <p role="status" className="text-xs text-amber-600 dark:text-amber-400">{gs1CheckDigitWarning(barcode)}</p>
                    )}
                  </Field>
                </div>
              )}
            </FormSection>

            <FormSection
              title="Prix"
              description={
                canEditCost ? "Montants en dirhams. Le coût d'achat sert au calcul de la marge et du bénéfice." : "Montants en dirhams."
              }
            >
              <div className={cn("grid gap-4", canEditCost ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
                <Field>
                  <Label htmlFor="price" required>
                    Prix de vente
                  </Label>
                  <MoneyInput id="price" name="price" required defaultValue={product?.price} />
                </Field>
                <Field>
                  <Label htmlFor="salePrice">Prix promotionnel</Label>
                  <MoneyInput id="salePrice" name="salePrice" defaultValue={product?.salePrice ?? ""} />
                </Field>
                {canEditCost && (
                  <Field>
                    <Label htmlFor="cost">Coût d&apos;achat</Label>
                    <MoneyInput id="cost" name="cost" defaultValue={product?.cost ?? ""} />
                  </Field>
                )}
              </div>
            </FormSection>

            <FormSection title="Stock">
              <div className="grid items-start gap-4 sm:grid-cols-2">
                <label
                  htmlFor="trackInventory"
                  className="flex cursor-pointer items-start gap-3 rounded-lg border bg-muted/30 p-3 transition-colors hover:border-primary/40"
                >
                  <Checkbox id="trackInventory" name="trackInventory" defaultChecked={product?.trackInventory ?? true} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">Suivre le stock</span>
                    <span className="block text-xs text-muted-foreground">Quantités par emplacement, alertes de stock faible.</span>
                  </span>
                </label>
                <Field>
                  <Label htmlFor="lowStockThreshold">Seuil de stock faible</Label>
                  <Input
                    id="lowStockThreshold"
                    name="lowStockThreshold"
                    type="number"
                    min="0"
                    className="tabular-nums"
                    defaultValue={product?.lowStockThreshold ?? defaultLowStockThreshold}
                  />
                  <FieldHint>Alerte quand le stock disponible atteint ce niveau.</FieldHint>
                </Field>
              </div>
            </FormSection>

            {!product && channels.length > 0 && (
              <FormSection
                title="Canaux de vente"
                description="Où ce produit peut être vendu. Le stock reste physique, par emplacement — il n'est pas dupliqué par canal."
              >
                <input type="hidden" name="channelsSubmitted" value="1" />
                <div className="grid gap-2 sm:grid-cols-2">
                  {channels.map((c) => {
                    const Icon = c.kind === "ONLINE" ? Globe : Store;
                    const checked = checkedChannels.has(c.id);
                    return (
                      <label
                        key={c.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:border-primary/40",
                          checked && "border-primary/40 bg-accent/60"
                        )}
                      >
                        <Checkbox
                          name="salesChannelIds"
                          value={c.id}
                          checked={checked}
                          onCheckedChange={(next) =>
                            setCheckedChannels((prev) => {
                              const set = new Set(prev);
                              if (next) set.add(c.id);
                              else set.delete(c.id);
                              return set;
                            })
                          }
                        />
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <Icon className="size-3.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{c.name}</span>
                          <span className="block text-xs text-muted-foreground">{c.kind === "ONLINE" ? "En ligne" : "Magasin"}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </FormSection>
            )}

            <FormSection title={product ? "Description" : "Image & description"}>
              {!product && (
                <Field>
                  <Label htmlFor="imageUrl">Lien de l&apos;image</Label>
                  <div className="flex items-center gap-3">
                    <ProductThumb imageUrl={imagePreview || null} className="size-9" />
                    <Input
                      id="imageUrl"
                      name="imageUrl"
                      type="url"
                      placeholder="https://…"
                      className="flex-1"
                      onChange={(e) => setImagePreview(e.target.value)}
                      aria-invalid={Boolean(state && !state.ok && state.fieldErrors?.imageUrl) || undefined}
                    />
                  </div>
                  <FieldHint>Lien d&apos;une image déjà hébergée ailleurs — modifiable plus tard depuis la fiche produit.</FieldHint>
                  <FieldError>{state && !state.ok ? state.fieldErrors?.imageUrl?.[0] : undefined}</FieldError>
                </Field>
              )}
              <Field>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  name="description"
                  rows={4}
                  defaultValue={product?.description ?? ""}
                  placeholder="Matière, dimensions, conseils d'entretien…"
                />
              </Field>
            </FormSection>

            {!product && (
              <FormSection title="Variantes">
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:border-primary/40",
                    hasVariants && "border-primary/40 bg-accent/60"
                  )}
                >
                  <Checkbox checked={hasVariants} onCheckedChange={(checked) => setHasVariants(checked === true)} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">Ce produit possède des variantes (couleurs, tailles…)</span>
                    <span className="block text-xs text-muted-foreground">
                      Le produit se crée d&apos;abord normalement — l&apos;écran suivant s&apos;ouvre directement sur la
                      définition des variantes.
                    </span>
                  </span>
                </label>
              </FormSection>
            )}
          </FormSectionGroup>
        </CardContent>
      </Card>

      <FormActions
        context={!product && hasVariants ? "Étape suivante : définition des variantes." : "Les champs marqués * sont obligatoires."}
      >
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Annuler
        </Button>
        <Button type="submit" loading={isPending}>
          {product ? "Enregistrer" : hasVariants ? "Créer et définir les variantes" : "Créer le produit"}
        </Button>
      </FormActions>
    </form>
  );

  // Rendered at one of two grid positions depending on whether the identity
  // fields (reference/barcode) are shown — a plain closure, not a component
  // defined at module level, because it reads this form's own local state.
  function renderCategoryField() {
    return (
      <Field>
        <Label htmlFor="categoryId">Catégorie</Label>
        <div className="flex gap-2">
          <Select name="categoryId" value={categoryId} onValueChange={(v) => setCategoryId(v ?? "")}>
            <SelectTrigger id="categoryId" className="w-full min-w-0 flex-1">
              <SelectValue placeholder="Aucune catégorie">
                {(value: string) => categories.find((c) => c.id === value)?.name ?? "Aucune catégorie"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!product && identityEnabled && (
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              aria-expanded={newCategoryOpen}
              onClick={() => setNewCategoryOpen((o) => !o)}
            >
              <Plus className="size-4" />
              Nouvelle
            </Button>
          )}
        </div>
        {!product && identityEnabled && newCategoryOpen && (
          <div className="flex gap-2 rounded-lg border border-primary/25 bg-accent/50 p-2">
            <Input
              autoFocus
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="Nom de la nouvelle catégorie"
              aria-label="Nouvelle catégorie"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreateCategory();
                }
                if (e.key === "Escape") setNewCategoryOpen(false);
              }}
            />
            <Button type="button" loading={creatingCategory} onClick={handleCreateCategory}>
              Créer
            </Button>
          </div>
        )}
      </Field>
    );
  }
}

/** A number input with a trailing currency unit, so the label doesn't have to carry "(MAD)". */
function MoneyInput(props: React.ComponentProps<typeof Input>) {
  return (
    <div className="relative">
      <Input type="number" step="0.01" min="0" placeholder="0,00" {...props} className="pr-12 tabular-nums" />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs font-medium text-muted-foreground">MAD</span>
    </div>
  );
}
