"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { createCategoryAction, updateCategoryAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { ActionResult } from "@/actions/types";
import type { Category } from "@prisma/client";

/** "Chaussures Homme" → "chaussures-homme" — a live suggestion only; the
 * server (createCategoryAction/updateCategoryAction) re-derives/validates
 * the real slug independently, this never needs to match it exactly. */
function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface CategoryOption {
  id: string;
  name: string;
}

/**
 * Create/edit dialog for /catalogue/categories (Batch 3, Task 1). Reuses
 * the existing createCategoryAction / updateCategoryAction — no new
 * business rules, just the missing management UI around them (the
 * product-form's inline "+ Créer" only ever calls createCategoryAction
 * with a name; this is the first UI for updateCategoryAction).
 */
export function CategoryFormDialog({
  category,
  categoryOptions,
}: {
  /** Edit mode when set. A category synced from WooCommerce/Shopify never
   * gets here — the page only renders this dialog for an INTERNE row. */
  category?: { id: string; name: string; slug: string; description: string | null; parentId: string | null };
  /** Parent-category choices — the category being edited is excluded by the caller. */
  categoryOptions: CategoryOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState(category?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(Boolean(category));
  const [parentId, setParentId] = useState(category?.parentId ?? "");

  const action = category ? updateCategoryAction : createCategoryAction;
  const [state, formAction, isPending] = useActionState(
    async (_prev: ActionResult<Category> | undefined, formData: FormData) => {
      const result = await action(formData);
      if (result.ok) {
        toast.success(category ? "Catégorie mise à jour." : "Catégorie créée.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          category ? (
            <Button type="button" size="icon" variant="ghost" aria-label="Modifier la catégorie" />
          ) : (
            <Button type="button" />
          )
        }
      >
        {category ? <Pencil className="size-4" /> : (
          <>
            <Plus className="size-4" />
            Nouvelle catégorie
          </>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? "Modifier la catégorie" : "Nouvelle catégorie"}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-3">
          {category && <input type="hidden" name="id" value={category.id} />}
          <div className="space-y-1.5">
            <Label htmlFor={`cat-name-${category?.id ?? "new"}`}>Nom</Label>
            <Input
              id={`cat-name-${category?.id ?? "new"}`}
              name="name"
              required
              defaultValue={category?.name ?? ""}
              onChange={(e) => {
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
            {state && !state.ok && state.fieldErrors?.name && (
              <p className="text-xs text-destructive">{state.fieldErrors.name[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`cat-slug-${category?.id ?? "new"}`}>Slug</Label>
            <Input
              id={`cat-slug-${category?.id ?? "new"}`}
              name="slug"
              required
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">Utilisé dans les URL — minuscules, chiffres, tirets uniquement.</p>
            {state && !state.ok && state.fieldErrors?.slug && (
              <p className="text-xs text-destructive">{state.fieldErrors.slug[0]}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`cat-parent-${category?.id ?? "new"}`}>Catégorie parente (optionnel)</Label>
            <Select name="parentId" value={parentId} onValueChange={(v) => setParentId(v ?? "")}>
              <SelectTrigger id={`cat-parent-${category?.id ?? "new"}`} className="w-full">
                <SelectValue placeholder="Aucune">
                  {(value: string) => categoryOptions.find((c) => c.id === value)?.name ?? "Aucune"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {categoryOptions.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`cat-desc-${category?.id ?? "new"}`}>Description (optionnel)</Label>
            <Textarea id={`cat-desc-${category?.id ?? "new"}`} name="description" rows={3} defaultValue={category?.description ?? ""} />
          </div>
          {state && !state.ok && !state.fieldErrors && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement…" : category ? "Enregistrer" : "Créer la catégorie"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
