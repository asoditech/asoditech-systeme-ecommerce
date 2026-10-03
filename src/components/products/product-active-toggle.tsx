"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Power, PowerOff } from "lucide-react";
import { setProductActiveAction } from "@/actions/products";
import { Button } from "@/components/ui/button";
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

/**
 * ACTIF ⇄ désactivé (ARCHIVE) — the normal lifecycle action (docs/adr/0054).
 * Server-authorized (`products.edit`); deactivation is confirmed, nothing is deleted.
 */
export function ProductActiveToggle({ productId, productName, active }: { productId: string; productName: string; active: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);

  async function run(next: boolean) {
    setRunning(true);
    const fd = new FormData();
    fd.set("productId", productId);
    fd.set("active", next ? "1" : "0");
    const res = await setProductActiveAction(fd);
    setRunning(false);
    setOpen(false);
    if (res.ok) {
      toast.success(next ? "Produit réactivé." : "Produit désactivé — il reste dans l'historique mais n'est plus vendable.");
      router.refresh();
    } else toast.error(res.error);
  }

  if (!active) {
    return (
      <Button type="button" variant="outline" loading={running} onClick={() => run(true)}>
        <Power className="size-4" />
        Réactiver
      </Button>
    );
  }
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <PowerOff className="size-4" />
        Désactiver
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Désactiver « {productName} » ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le produit ne pourra plus être vendu (commandes, caisse) ni exporté par défaut. Son historique — commandes, ventes, stock,
              réceptions — est conservé, et vous pourrez le réactiver à tout moment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={running}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={() => run(false)} disabled={running}>
              Désactiver
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
