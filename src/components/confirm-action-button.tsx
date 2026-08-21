"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/actions/types";

/**
 * A button that requires confirmation before submitting a Server Action.
 * Used for irreversible or state-changing actions (cancel order, adjust
 * stock, disconnect integration) so they're never one accidental click away.
 */
export function ConfirmActionButton({
  label,
  title,
  description,
  hiddenFields,
  action,
  successMessage,
  variant = "outline",
  destructive = false,
  disabled = false,
}: {
  label: string;
  title: string;
  description: string;
  hiddenFields: Record<string, string>;
  action: (formData: FormData) => Promise<ActionResult<unknown>>;
  successMessage: string;
  variant?: "outline" | "destructive" | "default" | "ghost";
  destructive?: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<unknown> | undefined, formData: FormData) => action(formData),
    undefined
  );

  if (state?.ok && open) {
    setOpen(false);
  }

  useEffect(() => {
    if (state?.ok) {
      toast.success(successMessage);
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button type="button" variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <form action={formAction}>
          {Object.entries(hiddenFields).map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
            <AlertDialogAction
              type="submit"
              disabled={isPending}
              variant={destructive ? "destructive" : "default"}
            >
              {isPending ? "En cours..." : "Confirmer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
