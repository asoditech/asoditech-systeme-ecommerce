"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, PackageCheck, PackageX, ScanBarcode, TriangleAlert } from "lucide-react";
import { resolveReturnCodeAction } from "@/actions/returns";
import { inspectReturnReceptionAction } from "@/actions/return-receiving";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { LOOKUP_SCAN_FORMATS } from "@/lib/barcode-scanner/support";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScanCodeInput } from "@/components/returns/scan-code-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCard, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
  draftToEntries,
  draftTotals,
  matchScannedUnit,
  registerUnit,
  setLineQuantity,
  RETURN_UNIT_CONDITION_LABELS,
  type InspectionDraftLine,
  type PendingScan,
} from "@/lib/returns/inspection-draft";
import type { ReturnUnitCondition } from "@/lib/validation/return-receiving";

export interface InspectionFormLine {
  orderItemId: string;
  nameSnapshot: string;
  skuSnapshot: string;
  productId: string | null;
  variationId: string | null;
  shippedQuantity: number;
  alreadyReturned: number;
}

/**
 * P3 — inspection of ONE received parcel. Each article is either scanned
 * (then its condition MUST be chosen before it counts) or typed into the
 * explicit « Revendable » / « Endommagé » columns. Units left at zero are
 * « non reçus » and stay returnable later. Submission goes through
 * inspectReturnReceptionAction (one transaction, idempotent key per screen).
 */
export function ReturnInspectionForm({ receptionId, lines }: { receptionId: string; lines: InspectionFormLine[] }) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<InspectionDraftLine[]>(() =>
    lines.map((l) => ({
      orderItemId: l.orderItemId,
      label: l.nameSnapshot,
      productId: l.productId,
      variationId: l.variationId,
      remaining: Math.max(0, l.shippedQuantity - l.alreadyReturned),
      sellable: 0,
      damaged: 0,
    }))
  );
  const [pending, setPending] = React.useState<PendingScan | null>(null);
  const [code, setCode] = React.useState("");
  const [feedback, setFeedback] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [note, setNote] = React.useState("");
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isResolving, startResolve] = React.useTransition();
  const [isSubmitting, startSubmit] = React.useTransition();
  // One key for this screen: a retry (double click, network blip) is a
  // server-side no-op, never a second return event.
  const [idempotencyKey] = React.useState(() => crypto.randomUUID());
  const submitted = React.useRef(false);
  // The server answers after a round-trip: always match against the LATEST draft.
  const draftRef = React.useRef(draft);
  React.useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const totals = draftTotals(draft);
  const byId = new Map(lines.map((l) => [l.orderItemId, l]));

  function resolve(raw: string) {
    const value = raw.trim();
    if (!value) return;
    if (pending) {
      setFeedback({ ok: false, text: `Choisissez d'abord l'état de « ${pending.label} ».` });
      return;
    }
    // Empty the field at once: the scanner's next code must not be appended to this one.
    setCode("");
    startResolve(async () => {
      try {
        const r = await resolveReturnCodeAction({ code: value, scope: "order" });
        if (!r.ok) {
          setFeedback({ ok: false, text: r.error });
        } else {
          const match = matchScannedUnit(draftRef.current, r.data);
          if (match.ok) {
            setPending(match.pending);
            setFeedback(null);
          } else {
            setFeedback({ ok: false, text: match.error });
          }
        }
      } catch {
        setFeedback({ ok: false, text: "Lecture impossible — réessayez." });
      }
    });
  }

  function choose(condition: ReturnUnitCondition) {
    if (!pending) return;
    const r = registerUnit(draft, pending.orderItemId, condition);
    if (r.ok) {
      setDraft(r.lines);
      setFeedback({ ok: true, text: `${pending.label} — ${condition === "SELLABLE" ? "revendable" : "endommagé"} (+1).` });
    } else {
      setFeedback({ ok: false, text: r.error });
    }
    setPending(null);
  }

  function submit() {
    if (submitted.current) return;
    const entries = draftToEntries(draft);
    if (entries.length === 0) {
      toast.error("Enregistrez au moins un article inspecté.");
      return;
    }
    submitted.current = true;
    startSubmit(async () => {
      try {
        const result = await inspectReturnReceptionAction({
          receptionId,
          idempotencyKey,
          note: note.trim() || undefined,
          entries,
        });
        if (result.ok) {
          toast.success("Inspection enregistrée.");
          setConfirmOpen(false);
          router.push("/livraison/retours?state=INSPECTE");
          router.refresh();
          return;
        }
        toast.error(result.error);
      } catch {
        toast.error("Action impossible — vérifiez vos droits et réessayez.");
      }
      submitted.current = false;
      setConfirmOpen(false);
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-tile border border-dashed border-field-border p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <ScanCodeInput
            value={code}
            onValueChange={setCode}
            onSubmitCode={resolve}
            placeholder="Code-barres ou SKU exact de l'article…"
            aria-label="Code de l'article inspecté"
            disabled={pending !== null}
          />
          <Button type="button" variant="outline" disabled={isResolving || !code.trim() || pending !== null} onClick={() => resolve(code)}>
            <ScanBarcode className="size-4" />
            Identifier
          </Button>
          <BarcodeScanButton formats={LOOKUP_SCAN_FORMATS} onDetect={resolve} label="Scanner" />
        </div>
        {pending && (
          <div role="group" aria-label="État de l'article scanné" className="space-y-2 rounded-tile bg-pill-neutral p-3">
            <p className="text-sm">
              Article : <span className="font-medium">{pending.label}</span> — quel est son état ?
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={() => choose("SELLABLE")}>
                <PackageCheck className="size-4" />
                {RETURN_UNIT_CONDITION_LABELS.SELLABLE}
              </Button>
              <Button type="button" size="sm" variant="destructive" onClick={() => choose("DAMAGED")}>
                <PackageX className="size-4" />
                {RETURN_UNIT_CONDITION_LABELS.DAMAGED}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>
                Annuler
              </Button>
            </div>
          </div>
        )}
        {feedback && (
          <p role="status" className={`flex items-start gap-1.5 text-xs ${feedback.ok ? "text-pill-green-fg" : "text-destructive"}`}>
            {feedback.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />}
            {feedback.text}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Un article scanné ne compte qu&apos;après le choix de son état. Vous pouvez aussi saisir les quantités ci-dessous.
        </p>
      </div>

      <TableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Article</TableHead>
              <TableHead className="text-right">Expédié</TableHead>
              <TableHead className="text-right">Déjà retourné</TableHead>
              <TableHead className="w-28">Revendable</TableHead>
              <TableHead className="w-28">Endommagé</TableHead>
              <TableHead className="text-right">Non reçu</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {draft.map((l) => {
              const src = byId.get(l.orderItemId)!;
              const open = l.remaining > 0;
              return (
                <TableRow key={l.orderItemId}>
                  <TableCell>
                    <div className="font-medium">{src.nameSnapshot}</div>
                    <div className="text-xs text-muted-foreground">{src.skuSnapshot}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{src.shippedQuantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{src.alreadyReturned}</TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      max={l.remaining}
                      value={l.sellable}
                      disabled={!open}
                      aria-label={`Revendable — ${src.nameSnapshot}`}
                      onChange={(e) => setDraft((d) => setLineQuantity(d, l.orderItemId, "SELLABLE", e.target.value))}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min={0}
                      max={l.remaining}
                      value={l.damaged}
                      disabled={!open}
                      aria-label={`Endommagé — ${src.nameSnapshot}`}
                      onChange={(e) => setDraft((d) => setLineQuantity(d, l.orderItemId, "DAMAGED", e.target.value))}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {open ? Math.max(0, l.remaining - l.sellable - l.damaged) : <span className="text-xs text-muted-foreground">Déjà retourné</span>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCard>

      <div className="space-y-1.5">
        <Label htmlFor="inspection-note">Note (facultative)</Label>
        <Textarea id="inspection-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {totals.sellable} revendable(s) · {totals.damaged} endommagé(s) · {totals.notReceived} non reçu(s)
        </p>
        <Button
          type="button"
          disabled={isSubmitting || pending !== null || totals.sellable + totals.damaged === 0}
          onClick={() => setConfirmOpen(true)}
        >
          Terminer l&apos;inspection
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !isSubmitting && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmer l&apos;inspection</AlertDialogTitle>
            <AlertDialogDescription>
              {totals.sellable} unité(s) revendable(s) seront remises en stock disponible ; {totals.damaged} unité(s)
              endommagée(s) seront enregistrées sans être remises en stock. {totals.notReceived} unité(s) non reçue(s)
              restent ouvertes pour une réception ultérieure. Le statut de la commande et celui du transporteur ne
              changent pas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={isSubmitting}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction type="button" onClick={submit} disabled={isSubmitting}>
              {isSubmitting ? "Enregistrement…" : "Confirmer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
