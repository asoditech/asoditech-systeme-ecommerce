"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, TriangleAlert } from "lucide-react";
import {
  evaluateScannerSupport,
  classifyScannerError,
  scannerStatusMessage,
  RELEVANT_BARCODE_FORMATS,
  type ScannerErrorKind,
} from "@/lib/barcode-scanner/support";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ScanPhase =
  | { kind: "checking" }
  | { kind: "unsupported"; reason: "unsupported-detector" | "unsupported-camera" }
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "error"; errorKind: ScannerErrorKind };

const INITIAL_PHASE: ScanPhase = { kind: "checking" };
const DETECT_INTERVAL_MS = 300;

/**
 * Camera barcode scanning (Batch 5) — an ADDITIONAL input method next to
 * the existing text field, never a replacement: a hardware keyboard-wedge
 * scanner or manual typing into that field keeps working completely
 * unchanged, since this component never touches it directly — it only
 * calls `onDetect(code)` with whatever the camera read, exactly as if the
 * operator had typed/scanned it themselves. No global key listeners, no
 * second lookup implementation: the caller feeds the code into its own
 * existing search (see SaleForm's `search(code)`).
 *
 * Native `BarcodeDetector` only — no dependency added (see
 * barcode-detector.d.ts for the ambient type; not yet in TS's own
 * lib.dom.d.ts). Every failure mode (unsupported browser, permission
 * denied, no camera, camera busy, a stray per-frame detect error) is
 * caught and shown as a plain French message; nothing here can throw
 * uncaught into the page. The camera stream and detection loop are always
 * stopped together, on detection, on close, on error, and on unmount —
 * driven by one effect keyed on `open`, so React's own cleanup semantics
 * guarantee it, not a manually-called "stop" function that could be missed.
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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    const video = videoRef.current;

    // The whole sequence (support check -> permission prompt -> stream ->
    // detection loop) runs inside this async task rather than synchronously
    // in the effect body, so every `setPhase` call — including the very
    // first, synchronous-looking support check below — happens from within
    // a callback, not the effect body itself (react-hooks/set-state-in-effect).
    void (async () => {
      const support = evaluateScannerSupport({
        hasBarcodeDetector: typeof window !== "undefined" && "BarcodeDetector" in window,
        hasMediaDevices: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
      });
      if (support !== "supported") {
        if (!cancelled) setPhase({ kind: "unsupported", reason: support });
        return;
      }

      if (!cancelled) setPhase({ kind: "starting" });
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      } catch (err) {
        if (!cancelled) setPhase({ kind: "error", errorKind: classifyScannerError(err) });
        return;
      }
      if (cancelled) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      if (video) {
        video.srcObject = s;
        void video.play();
      }

      let detector: BarcodeDetector;
      try {
        detector = new window.BarcodeDetector!({ formats: [...RELEVANT_BARCODE_FORMATS] });
      } catch {
        // A browser can support BarcodeDetector but reject one of our
        // requested formats — fall back to its own default set rather
        // than failing the whole scan.
        detector = new window.BarcodeDetector!();
      }
      setPhase({ kind: "scanning" });
      interval = setInterval(() => {
        if (!video || video.readyState < 2) return;
        detector
          .detect(video)
          .then((codes) => {
            if (cancelled || codes.length === 0) return;
            onDetect(codes[0].rawValue);
            setOpen(false);
          })
          .catch(() => {
            // One frame failed to decode — not fatal, the next tick tries again.
          });
      }, DETECT_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
  }, [open, onDetect]);

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
        className="w-full sm:w-auto"
        onClick={() => {
          // Reset synchronously, in this real user-event handler — not in
          // the effect — so a re-open never flashes the previous session's
          // leftover "error"/"unsupported" phase before the checks re-run.
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
          <DialogDescription>Pointez la caméra vers le code-barres de l&apos;article.</DialogDescription>
        </DialogHeader>

        {message ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-6 text-center text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-5 shrink-0" />
            <p>{message}</p>
          </div>
        ) : (
          <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
            <video ref={videoRef} className="size-full object-cover" muted playsInline aria-label="Aperçu caméra pour le scan de code-barres" />
            {phase.kind === "starting" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-sm text-white">
                <Loader2 className="size-6 animate-spin" />
                Ouverture de la caméra…
              </div>
            )}
            {phase.kind === "scanning" && (
              <div className="pointer-events-none absolute inset-6 rounded-lg border-2 border-white/80" aria-hidden="true" />
            )}
          </div>
        )}

        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Fermer
        </Button>
      </DialogContent>
    </Dialog>
  );
}
