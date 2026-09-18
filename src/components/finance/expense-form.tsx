"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { createExpenseAction, updateExpenseAction } from "@/actions/finance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ExpenseCategory } from "@prisma/client";
import type { ActionResult, IdResult } from "@/actions/types";

/** Plain-serializable shape — never pass a Prisma row (Decimal `amount`)
 * straight from a Server Component into this Client Component. */
export interface EditableExpense {
  id: string;
  categoryId: string;
  amount: string;
  date: string;
  description: string | null;
  vendor: string | null;
}

/** Pass `expense` to edit an existing row (updateExpenseAction) instead of
 * creating a new one. There is deliberately no delete — see
 * `// Deliberately no deleteExpenseAction` in src/actions/finance.ts: a
 * correction goes through this same edit form instead of hard-deleting a
 * recorded expense. */
export function ExpenseForm({
  categories,
  expense,
}: {
  categories: ExpenseCategory[];
  expense?: EditableExpense;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isEdit = Boolean(expense);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = isEdit ? await updateExpenseAction(formData) : await createExpenseAction(formData);
      if (result.ok) {
        toast.success(isEdit ? "Dépense modifiée." : "Dépense enregistrée.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          isEdit ? (
            <Button type="button" variant="ghost" size="icon" aria-label="Modifier la dépense" />
          ) : (
            <Button type="button" />
          )
        }
      >
        {isEdit ? (
          <Pencil className="size-4" />
        ) : (
          <>
            <Plus className="size-4" />
            Nouvelle dépense
          </>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Modifier la dépense" : "Enregistrer une dépense"}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          {isEdit && <input type="hidden" name="id" value={expense!.id} />}
          <div className="space-y-1.5">
            <Label htmlFor="categoryId">Catégorie</Label>
            <Select name="categoryId" required defaultValue={expense?.categoryId}>
              <SelectTrigger id="categoryId" className="w-full">
                <SelectValue placeholder="Choisir une catégorie">
                  {(value: string) => categories.find((c) => c.id === value)?.name ?? "Choisir une catégorie"}
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
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="amount">Montant (MAD)</Label>
              <Input
                id="amount"
                name="amount"
                type="number"
                step="0.01"
                min="0"
                required
                defaultValue={expense?.amount}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="date">Date</Label>
              <Input id="date" name="date" type="date" defaultValue={expense?.date ?? today} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Fournisseur (optionnel)</Label>
            <Input id="vendor" name="vendor" defaultValue={expense?.vendor ?? undefined} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea id="description" name="description" rows={2} defaultValue={expense?.description ?? undefined} />
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : isEdit ? "Enregistrer les modifications" : "Enregistrer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
