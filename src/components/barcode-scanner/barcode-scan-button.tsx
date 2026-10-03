"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { scannerStatusMessage, RELEVANT_BARCODE_FORMATS } from "@/lib/barcode-scanner/support";
import { startScanSession, type ScanPhase } from "@/lib/barcode-scanner/session";
import { createBarcodeDecoder, loadZXingDetector, type NativeDetectorCtor } from "@/lib/barcode-scanner/decoder";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const INITIAL_PHASE: ScanPhase = { kind: "checking" };

/**
 * Camera barcode scanning — an ADDITIONAL input method next to the existing
 * text field, never a replacement: a hardware keyboard-wedge scanner or
 * manual typing keeps working unchanged, since this component never touches
 * that field — it only calls `onDetect(code)` with what the camera read,
 * exactly as if the operator had typed it. The caller feeds the code into
 * its own existing search; nothing here creates a sale/reception line,
 * moves stock or writes anything.
 *
 * Decoder: the browser's native `BarcodeDetector` when usable, otherwise
 * the self-hosted ZXing WebAssembly decoder loaded on first open
 * (src/lib/barcode-scanner/decoder.ts) — iPhone/iPad, Firefox. The lifecycle lives in
 * src/lib/barcode-scanner/session.ts (unit-tested with fakes): camera
 * requested only after the user opens the dialog, one detection per
 * session, camera always released on detection, close, error and unmount.
 */
export function BarcodeScanButton({
  onDetect,
  label = "Scanner",
}: {
  onDetect: (code: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ScanPhase>(INITIAL_PHASE);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Latest callback without restarting the camera when the parent re-renders
  // (callers pass inline functions).
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    if (!open) return;
    const session = startScanSession({
      env: {
        isSecureContext: typeof window !== "undefined" ? window.isSecureContext : undefined,
        hasBarcodeDetector: typeof window !== "undefined" && "BarcodeDetector" in window,
        hasWebAssembly: typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function",
        hasMediaDevices: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
      },
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      // Native detector when usable, else the lazily-loaded WebAssembly one
      // (iPhone/iPad, Firefox…) — src/lib/barcode-scanner/decoder.ts.
      createDetector: async () =>
        (
          await createBarcodeDecoder(RELEVANT_BARCODE_FORMATS, {
            nativeCtor: window.BarcodeDetector as NativeDetectorCtor | undefined,
            loadWasmDetector: loadZXingDetector,
          })
        ).detector,
      getVideo: () => videoRef.current,
      every: (ms, tick) => {
        const id = setInterval(tick, ms);
        return () => clearInterval(id);
      },
      onPhase: setPhase,
      onDetect: (code) => {
        // Haptic confirmation where supported (Android); silently ignored elsewhere.
        try {
          navigator.vibrate?.(60);
        } catch {
          // ignore
        }
        onDetectRef.current(code);
        setOpen(false);
      },
    });
    return () => session.stop();
  }, [open]);

  const message =
    phase.kind === "unsupported"
      ? scannerStatusMessage(phase.reason)
      : phase.kind === "error"
        ? scannerStatusMessage(phase.errorKind)
        : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        // An empty `label` renders a compact icon-only button (e.g. attached
        // to a barcode input) — still named for assistive tech + tooltip.
        size={label ? "default" : "icon"}
        className={label ? "w-full sm:w-auto" : "shrink-0"}
        aria-label={label ? undefined : "Scanner avec la caméra"}
        title={label ? undefined : "Scanner avec la caméra"}
        onClick={() => {
          // Reset synchronously, in this real user-event handler — a re-open
          // never flashes the previous session's leftover state.
          setPhase(INITIAL_PHASE);
          setOpen(true);
        }}
      >
        <Camera className="size-4" />
        {label}
      </Button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Scanner un code-barres</DialogTitle>
          <DialogDescription>
            Placez le code-barres dans le cadre, à 10–20 cm, bien éclairé. La lecture est automatique.
          </DialogDescription>
        </DialogHeader>

        {message ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-6 text-center text-sm text-amber-700 dark:text-amber-400"
          >
            <TriangleAlert className="size-5 shrink-0" />
            <p>{message}</p>
          </div>
        ) : (
          <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
            <video ref={videoRef} className="size-full object-cover" muted playsInline aria-label="Aperçu caméra pour le scan de code-barres" />
            {(phase.kind === "checking" || phase.kind === "starting") && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-sm text-white" role="status">
                <Loader2 className="size-6 animate-spin" />
                Ouverture de la caméra… Autorisez l&apos;accès si le navigateur le demande.
              </div>
            )}
            {phase.kind === "loading" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center text-sm text-white" role="status">
                <Loader2 className="size-6 animate-spin" />
                Chargement du lecteur de codes-barres… (première ouverture uniquement)
              </div>
            )}
            {phase.kind === "scanning" && (
              <>
                <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-white/80" aria-hidden="true" />
                <p className="absolute inset-x-0 bottom-2 text-center text-xs text-white/90" role="status">
                  Recherche d&apos;un code-barres…
                </p>
              </>
            )}
            {phase.kind === "detected" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-white" role="status">
                <CheckCircle2 className="size-6 text-emerald-400" />
                Code lu : {phase.code}
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          La saisie manuelle et les scanners USB/Bluetooth restent utilisables à tout moment.
        </p>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Fermer
        </Button>
      </DialogContent>
    </Dialog>
  );
}
