"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CheckCircle2, ScanBarcode, TriangleAlert } from "lucide-react";
import { resolveReturnCodeAction } from "@/actions/returns";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ReturnScanResult, ScannedUnit } from "@/lib/returns/scan";

/**
 * « Scanner » for the return dialogs: the camera (shared scanner, single mode)
 * or a typed / USB-scanned code. The code is resolved on the server by the
 * shared exact resolver; `onUnit` applies it to the dialog's own lines and
 * says what happened. Manual quantities stay fully editable next to it.
 */
export function ReturnScanField({
  scope,
  onUnit,
}: {
  scope: "order" | "sale";
  onUnit: (unit: ScannedUnit) => ReturnScanResult;
}) {
  const [code, setCode] = useState("");
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  // The server answers after a round-trip: always apply with the LATEST lines/quantities.
  const onUnitRef = useRef(onUnit);
  useEffect(() => {
    onUnitRef.current = onUnit;
  }, [onUnit]);

  function resolve(raw: string) {
    const value = raw.trim();
    if (!value) return;
    startTransition(async () => {
      const r = await resolveReturnCodeAction({ code: value, scope });
      if (!r.ok) {
        setFeedback({ ok: false, text: r.error });
      } else {
        const applied = onUnitRef.current(r.data);
        setFeedback(applied.ok ? { ok: true, text: `${applied.label} — revendable ${applied.sellable}.` } : { ok: false, text: applied.error });
      }
      setCode("");
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              resolve(code);
            }
          }}
          placeholder="Code-barres ou SKU exact de l'article retourné…"
          aria-label="Code de l'article retourné"
        />
        <Button type="button" variant="outline" disabled={isPending || !code.trim()} onClick={() => resolve(code)}>
          <ScanBarcode className="size-4" />
          Ajouter
        </Button>
        <BarcodeScanButton onDetect={resolve} label="Scanner" />
      </div>
      {feedback && (
        <p
          role="status"
          className={`flex items-start gap-1.5 text-xs ${feedback.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}
        >
          {feedback.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />}
          {feedback.text}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">Chaque article lu ajoute 1 « revendable » ; ajustez revendable / endommagé ci-dessous si besoin.</p>
    </div>
  );
}
