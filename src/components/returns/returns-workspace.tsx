"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, PackageCheck, ScanBarcode, Trash2, TriangleAlert } from "lucide-react";
import {
  lookupReturnParcelAction,
  receiveReturnParcelAction,
  receiveReturnParcelsAction,
} from "@/actions/return-receiving";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScanCodeInput } from "@/components/returns/scan-code-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import type { ReceiveParcelResult } from "@/lib/returns/reception";
import type { ReturnParcelView } from "@/lib/queries/return-receiving";
import { lotRowDisplayState, type ReturnParcelDisplayState } from "@/lib/returns/lot-row-state";

const STATE_LABELS: Record<ReturnParcelDisplayState, string> = {
  A_RECEPTIONNER: "À réceptionner",
  A_INSPECTER: "Reçu — à inspecter",
  INSPECTE: "Inspecté",
  DEJA_RETOURNE: "Déjà retourné",
  NON_ELIGIBLE: "Non éligible",
};

const STATE_VARIANT: Record<ReturnParcelDisplayState, "outline" | "warning" | "success" | "secondary" | "destructive"> = {
  A_RECEPTIONNER: "outline",
  A_INSPECTER: "warning",
  INSPECTE: "success",
  DEJA_RETOURNE: "secondary",
  NON_ELIGIBLE: "destructive",
};

function formatWhen(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export function ReturnParcelStateBadge({ state }: { state: ReturnParcelDisplayState }) {
  return <Badge variant={STATE_VARIANT[state]}>{STATE_LABELS[state]}</Badge>;
}

/** What the batch did for one parcel — never a blanket « tout est OK ». */
function resultText(r: ReceiveParcelResult): { ok: boolean; text: string } {
  if (!r.ok) return { ok: false, text: r.error };
  if (r.status === "already_pending") return { ok: true, text: `Déjà réceptionné le ${formatWhen(r.receivedAt)} — à inspecter.` };
  return { ok: true, text: "Réceptionné — à inspecter." };
}

interface LotItem {
  parcel: ReturnParcelView;
  result?: ReceiveParcelResult;
}

/**
 * Scan / type a tracking number (exact) or an order number → the parcel joins
 * the current lot; « Réceptionner le lot » receives each parcel on its own and
 * shows each outcome. Reception never touches stock: units are counted at the
 * inspection step.
 */
export function ReturnsScanLot() {
  const router = useRouter();
  const [code, setCode] = React.useState("");
  const [feedback, setFeedback] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [choices, setChoices] = React.useState<ReturnParcelView[]>([]);
  const [lot, setLot] = React.useState<LotItem[]>([]);
  const [isLooking, startLookup] = React.useTransition();
  const [isReceiving, startReceive] = React.useTransition();

  // Lookups answer after a round-trip: dedupe against the LATEST lot.
  const lotRef = React.useRef(lot);
  React.useEffect(() => {
    lotRef.current = lot;
  }, [lot]);

  function addToLot(parcel: ReturnParcelView) {
    setChoices([]);
    const name = parcel.trackingNumber ?? parcel.orderLabel;
    if (lotRef.current.some((i) => i.parcel.shipmentId === parcel.shipmentId)) {
      setFeedback({ ok: false, text: `Le colis ${name} est déjà dans le lot.` });
      return;
    }
    lotRef.current = [...lotRef.current, { parcel }];
    setLot(lotRef.current);
    setFeedback({ ok: true, text: `${name} ajouté au lot.` });
  }

  function lookup(raw: string) {
    const query = raw.trim();
    if (!query) return;
    // Empty the field at once: the scanner's next code must not be appended to this one.
    setCode("");
    startLookup(async () => {
      try {
        const r = await lookupReturnParcelAction({ query });
        if (!r.ok) setFeedback({ ok: false, text: r.error });
        else if (r.data.length === 1) addToLot(r.data[0]);
        else {
          setChoices(r.data);
          setFeedback({ ok: true, text: `${r.data.length} colis correspondent — choisissez-en un.` });
        }
      } catch {
        setFeedback({ ok: false, text: "Recherche impossible — vérifiez vos droits et réessayez." });
      }
    });
  }

  const receivable = lot.filter((i) => !i.result && i.parcel.eligible && i.parcel.state === "A_RECEPTIONNER");

  function receiveLot() {
    if (receivable.length === 0) return;
    const ids = receivable.map((i) => i.parcel.shipmentId);
    startReceive(async () => {
      try {
        const r = await receiveReturnParcelsAction({ shipmentIds: ids });
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        const byId = new Map(r.data.map((i) => [i.shipmentId, i.result]));
        setLot((prev) => prev.map((i) => (byId.has(i.parcel.shipmentId) ? { ...i, result: byId.get(i.parcel.shipmentId) } : i)));
        const received = r.data.filter((i) => i.result.ok && i.result.status === "received").length;
        const already = r.data.filter((i) => i.result.ok && i.result.status === "already_pending").length;
        const failed = r.data.filter((i) => !i.result.ok).length;
        const summary = `${received} réceptionné(s), ${already} déjà réceptionné(s), ${failed} en erreur.`;
        if (failed > 0) toast.warning(summary);
        else toast.success(summary);
        router.refresh();
      } catch {
        toast.error("Réception impossible — vérifiez vos droits et réessayez.");
      }
    });
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <ScanCodeInput
          value={code}
          onValueChange={setCode}
          onSubmitCode={lookup}
          placeholder="N° de suivi exact ou n° de commande…"
          aria-label="Numéro de suivi ou de commande du colis retourné"
          className="sm:max-w-md"
        />
        <Button type="button" variant="outline" disabled={isLooking || !code.trim()} onClick={() => lookup(code)}>
          <ScanBarcode className="size-4" />
          Ajouter au lot
        </Button>
        <BarcodeScanButton onDetect={lookup} label="Scanner" mode="continuous" />
      </div>
      {feedback && (
        <p role="status" className={`flex items-start gap-1.5 text-xs ${feedback.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
          {feedback.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />}
          {feedback.text}
        </p>
      )}
      {choices.length > 0 && (
        <ul className="space-y-1 text-sm">
          {choices.map((c) => (
            <li key={c.shipmentId} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
              <span>
                {c.orderLabel} · {c.trackingNumber ?? "sans n° de suivi"} · {c.providerName}
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => addToLot(c)}>
                Choisir
              </Button>
            </li>
          ))}
        </ul>
      )}

      {lot.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Colis</TableHead>
                <TableHead>Commande</TableHead>
                <TableHead>Emplacement d&apos;origine</TableHead>
                <TableHead>État</TableHead>
                <TableHead>Résultat</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {lot.map(({ parcel, result }) => {
                const outcome = result
                  ? resultText(result)
                  : !parcel.eligible
                    ? { ok: false, text: "Non éligible : le transporteur n'indique pas « Retourné »." }
                    : parcel.state !== "A_RECEPTIONNER"
                      ? {
                          ok: false,
                          text:
                            parcel.state === "A_INSPECTER"
                              ? "Déjà réceptionné — à inspecter."
                              : parcel.state === "DEJA_RETOURNE"
                                ? "Toutes les unités de cette commande ont déjà été retournées."
                                : "Déjà réceptionné et inspecté.",
                        }
                      : null;
                const receptionId = result?.ok ? result.receptionId : parcel.pendingReception?.id;
                return (
                  <TableRow key={parcel.shipmentId}>
                    <TableCell>
                      <div className="font-medium">{parcel.trackingNumber ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{parcel.providerName}</div>
                    </TableCell>
                    <TableCell>
                      <div>{parcel.orderLabel}</div>
                      <div className="text-xs text-muted-foreground">
                        {parcel.recipientName}
                        {parcel.city ? ` · ${parcel.city}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>{parcel.warehouseName ?? "—"}</TableCell>
                    <TableCell>
                      <ReturnParcelStateBadge state={lotRowDisplayState(parcel, result)} />
                    </TableCell>
                    <TableCell className="text-xs">
                      {outcome && <span className={outcome.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}>{outcome.text}</span>}
                      {receptionId && (
                        <Link href={`/livraison/retours/inspection/${receptionId}`} className="ml-1 underline underline-offset-2">
                          Inspecter
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label="Retirer du lot"
                        onClick={() => setLot((prev) => prev.filter((i) => i.parcel.shipmentId !== parcel.shipmentId))}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setLot([])} disabled={isReceiving}>
              Vider le lot
            </Button>
            <Button type="button" onClick={receiveLot} disabled={isReceiving || receivable.length === 0}>
              <PackageCheck className="size-4" />
              {isReceiving ? "Réception…" : `Réceptionner le lot (${receivable.length})`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Row action: receive one parcel, or — for an already-inspected parcel with
 * units still out — an explicitly confirmed later reception. */
export function ReceiveParcelButton({ parcel }: { parcel: ReturnParcelView }) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const additional = parcel.state === "INSPECTE";

  function receive() {
    startTransition(async () => {
      try {
        const r = await receiveReturnParcelAction({ shipmentId: parcel.shipmentId, additional });
        if (!r.ok) toast.error(r.error);
        else {
          toast.success(resultText(r.data).text);
          if (r.data.ok) router.push(`/livraison/retours/inspection/${r.data.receptionId}`);
        }
      } catch {
        toast.error("Réception impossible — vérifiez vos droits et réessayez.");
      }
      setConfirmOpen(false);
      router.refresh();
    });
  }

  if (parcel.state === "A_INSPECTER" && parcel.pendingReception) {
    return (
      <Button size="sm" render={<Link href={`/livraison/retours/inspection/${parcel.pendingReception.id}`} />}>
        Inspecter
      </Button>
    );
  }
  if (additional && parcel.remainingUnits <= 0) return <span className="text-xs text-muted-foreground">Terminé</span>;
  // Every unit already recorded as returned (outside this workspace): nothing to receive.
  if (parcel.state === "DEJA_RETOURNE") return <span className="text-xs text-muted-foreground">Rien à réceptionner</span>;

  return (
    <>
      <Button size="sm" variant={additional ? "outline" : "default"} disabled={isPending} onClick={() => setConfirmOpen(true)}>
        {additional ? "Nouvelle réception" : "Réceptionner"}
      </Button>
      <AlertDialog open={confirmOpen} onOpenChange={(open) => !isPending && setConfirmOpen(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{additional ? "Nouvelle réception de ce colis" : "Réceptionner ce colis"}</AlertDialogTitle>
            <AlertDialogDescription>
              {additional
                ? `Ce colis a déjà été inspecté ; ${parcel.remainingUnits} unité(s) n'ont pas encore été reçues. Confirmez uniquement si ces articles viennent d'arriver.`
                : "Confirmez l'arrivée physique du colis à son emplacement d'origine. Aucun stock n'est modifié à cette étape : les articles seront comptés à l'inspection."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button" disabled={isPending}>
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction type="button" onClick={receive} disabled={isPending}>
              {isPending ? "Réception…" : "Confirmer la réception"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
