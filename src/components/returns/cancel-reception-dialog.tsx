"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import { cancelReturnReceptionAction } from "@/actions/return-receiving";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
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
import {
  RETURN_RECEPTION_CANCEL_REASONS,
  RETURN_RECEPTION_CANCEL_REASON_LABELS,
  type ReturnReceptionCancelReason,
} from "@/lib/validation/return-receiving";

/**
 * P3 — void a reception awaiting inspection that can't be inspected (empty or
 * wrong parcel, units already returned elsewhere). Reason required; « Autre »
 * also needs a note. Server side: cancelReturnReceptionAction (no stock,
 * order or carrier change; audited).
 */
export function CancelReceptionButton({ receptionId }: { receptionId: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<ReturnReceptionCancelReason | "">("");
  const [note, setNote] = React.useState("");
  const [isPending, startTransition] = React.useTransition();
  const submitted = React.useRef(false);

  const noteRequired = reason === "AUTRE";
  const canSubmit = reason !== "" && (!noteRequired || note.trim().length >= 3) && !isPending;

  function submit() {
    if (!canSubmit || submitted.current) return;
    submitted.current = true;
    startTransition(async () => {
      try {
        const r = await cancelReturnReceptionAction({ receptionId, reason, note: note.trim() || undefined });
        if (r.ok) {
          toast.success("Réception annulée — aucun stock n'a été modifié.");
          setOpen(false);
          router.push("/livraison/retours");
          router.refresh();
          return;
        }
        toast.error(r.error);
      } catch {
        toast.error("Action impossible — vérifiez vos droits et réessayez.");
      }
      submitted.current = false;
    });
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Ban className="size-4" />
        Annuler la réception
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !isPending && setOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Annuler cette réception</AlertDialogTitle>
            <AlertDialogDescription>
              À utiliser quand aucun article ne peut être inspecté sous cette réception. Aucun stock n&apos;est modifié et
              les statuts de la commande et du transporteur ne changent pas. S&apos;il reste des unités attendues, le colis
              redevient « À réceptionner ». L&apos;annulation et son motif sont enregistrés dans l&apos;historique.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cancel-reception-reason">Motif</Label>
              <NativeSelect
                id="cancel-reception-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as ReturnReceptionCancelReason | "")}
              >
                <option value="">Choisissez un motif…</option>
                {RETURN_RECEPTION_CANCEL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {RETURN_RECEPTION_CANCEL_REASON_LABELS[r]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cancel-reception-note">Note{noteRequired ? " (obligatoire)" : " (facultative)"}</Label>
              <Textarea id="cancel-reception-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={isPending}>
              Retour
            </AlertDialogCancel>
            <AlertDialogAction type="button" variant="destructive" onClick={submit} disabled={!canSubmit}>
              {isPending ? "Annulation…" : "Annuler la réception"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
