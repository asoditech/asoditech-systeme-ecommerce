"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { removeProductAction } from "@/actions/products";
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
 * Removes a product that no longer belongs — e.g. one deleted from the
 * connected store but still lingering here. Deletes it outright if it was
 * never sold, otherwise archives it (keeps order history linked).
 */
export function RemoveProductButton({
  productId,
  productName,
  neverSold,
}: {
  productId: string;
  productName: string;
  neverSold: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="size-4" />
        Retirer du catalogue
      </Button>
      <RemoveProductDialog
        open={open}
        onOpenChange={setOpen}
        productId={productId}
        productName={productName}
        neverSold={neverSold}
        after="redirect"
      />
    </>
  );
}

/**
 * The confirmation itself, controlled — opened by the product page's button or
 * by the products table's row menu. Same `removeProductAction` either way (the
 * server decides delete-vs-archive from the product's real references).
 * `neverSold` only tunes the wording; unknown (the table loads no per-row
 * counts) → the neutral « supprimé ou archivé » explanation. `after`:
 * "redirect" leaves the product page for /produits; "refresh" re-renders the list.
 */
export function RemoveProductDialog({
  open,
  onOpenChange,
  productId,
  productName,
  neverSold,
  after,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
  productName: string;
  neverSold?: boolean;
  after: "redirect" | "refresh";
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const fd = new FormData();
      fd.set("productId", productId);
      const res = await removeProductAction(fd);
      if (res.ok) {
        toast.success(res.data.deleted ? "Produit supprimé." : "Produit archivé (des commandes y font référence).");
        onOpenChange(false);
        if (after === "redirect") router.push("/produits");
        else router.refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Retirer « {productName} » ?</AlertDialogTitle>
          <AlertDialogDescription>
            {neverSold === undefined
              ? "S'il n'a jamais été vendu ni mouvementé, le produit sera supprimé définitivement (variations, images et stock inclus) ; sinon il sera archivé (masqué du catalogue et non commandable), pas supprimé, pour préserver l’historique."
              : neverSold
                ? "Ce produit n'a jamais été vendu — il sera supprimé définitivement (variations, images et stock inclus)."
                : "Des commandes font référence à ce produit — il sera archivé (masqué du catalogue et non commandable), pas supprimé, pour préserver l’historique."}
            {" "}À utiliser quand le produit a été supprimé de la boutique connectée ou n’a plus lieu d’être.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel type="button">Annuler</AlertDialogCancel>
          <AlertDialogAction type="button" variant="destructive" disabled={running} onClick={run}>
            {running ? "En cours…" : neverSold === undefined ? "Retirer" : neverSold ? "Supprimer" : "Archiver"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
