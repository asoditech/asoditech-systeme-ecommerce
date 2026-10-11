"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, PackageCheck, RotateCcw, ScanBarcode } from "lucide-react";
import { checkPackingScanAction, validatePackingAction } from "@/actions/packing";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { LOOKUP_SCAN_FORMATS } from "@/lib/barcode-scanner/support";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isPackingComplete, packingCounts, type PackingLine } from "@/lib/packing";
import { cn } from "@/lib/utils";

/**
 * « Emballage » (OrderStatus EN_PREPARATION): scan each packed article — exact
 * barcode or SKU — against the order lines. Progress is local; the final
 * « Valider l'emballage » sends the raw codes and the server re-checks
 * everything (src/actions/packing.ts). Manual lines are the controlled
 * fallback (orders.pack_manual + reason).
 */
export function PackingPanel({
  orderId,
  lines,
  canPackManual,
}: {
  orderId: string;
  lines: PackingLine[];
  canPackManual: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [keys, setKeys] = useState<string[]>([]);
  const [manualKeys, setManualKeys] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const counts = packingCounts(lines, keys, manualKeys);
  const complete = isPackingComplete(lines, counts);

  // Scans are checked one after another against the keys accepted so far
  // (a ref, not the last render's state): two fast scans never both pass
  // against the same stale count.
  const keysRef = useRef<string[]>([]);
  const scanQueue = useRef<Promise<void>>(Promise.resolve());

  function scan(raw?: string) {
    const value = (raw ?? code).trim();
    if (!value) return;
    // Empty the field at once: the scanner's next code must not be appended to this one.
    setCode("");
    const previous = scanQueue.current;
    let release = () => {};
    scanQueue.current = new Promise<void>((resolve) => (release = resolve));
    startTransition(async () => {
      await previous;
      try {
        const r = await checkPackingScanAction({ orderId, code: value, scannedKeys: keysRef.current, manualKeys });
        if (r.ok) {
          keysRef.current = [...keysRef.current, r.data.key];
          setCodes((p) => [...p, value]);
          setKeys(keysRef.current);
          setLastError(null);
          toast.success(`${r.data.label} — ajouté.`);
        } else {
          setLastError(r.error);
          toast.error(r.error);
        }
      } finally {
        release();
        inputRef.current?.focus();
      }
    });
  }

  function reset() {
    keysRef.current = [];
    setCodes([]);
    setKeys([]);
    setManualKeys([]);
    setReason("");
    setLastError(null);
    inputRef.current?.focus();
  }

  function validate() {
    startTransition(async () => {
      const r = await validatePackingAction({
        orderId,
        codes,
        manual: manualKeys.length > 0 ? { keys: manualKeys, reason } : undefined,
      });
      if (r.ok) {
        toast.success("Emballage vérifié.");
        router.refresh();
      } else {
        setLastError(r.error);
        toast.error(r.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageCheck className="size-4 text-muted-foreground" />
          Vérification de l&apos;emballage
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            ref={inputRef}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // The field's own value: a code scanned before hydration is in the DOM, not yet in state.
                scan(e.currentTarget.value);
              }
            }}
            placeholder="Scanner le code-barres ou saisir le SKU exact…"
            aria-label="Code de l'article emballé"
          />
          <Button type="button" variant="outline" disabled={isPending || !code.trim()} onClick={() => scan()}>
            <ScanBarcode className="size-4" />
            Vérifier
          </Button>
          <BarcodeScanButton formats={LOOKUP_SCAN_FORMATS} onDetect={(c) => scan(c)} label="Caméra" />
        </div>
        {lastError && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{lastError}</p>}

        <ul className="divide-y rounded-md border text-sm">
          {lines.map((l) => {
            const done = (counts[l.key] ?? 0) >= l.required;
            const manual = manualKeys.includes(l.key);
            return (
              <li key={l.key} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{l.label}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{l.sku}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {canPackManual && (!done || manual) && (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Checkbox
                        checked={manual}
                        onCheckedChange={(v) =>
                          setManualKeys((p) => (v === true ? [...new Set([...p, l.key])] : p.filter((k) => k !== l.key)))
                        }
                      />
                      Manuel
                    </label>
                  )}
                  <span className={cn("inline-flex items-center gap-1 tabular-nums", done ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                    {done && <CheckCircle2 className="size-4" />}
                    {counts[l.key] ?? 0}/{l.required}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>

        {manualKeys.length > 0 && (
          <div className="space-y-1.5">
            <label htmlFor="packing-reason" className="text-xs font-medium">
              Motif de la validation manuelle (obligatoire)
            </label>
            <Textarea
              id="packing-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex. code-barres absent ou illisible"
              rows={2}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={isPending || (codes.length === 0 && manualKeys.length === 0)}>
            <RotateCcw className="size-4" />
            Recommencer
          </Button>
          <Button type="button" onClick={validate} disabled={isPending || !complete || (manualKeys.length > 0 && reason.trim().length < 3)}>
            <PackageCheck className="size-4" />
            Valider l&apos;emballage
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
