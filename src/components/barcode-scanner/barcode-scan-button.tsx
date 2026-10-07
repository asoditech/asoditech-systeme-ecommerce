"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Flashlight, FlashlightOff, Loader2, ScanLine, TriangleAlert, ZoomIn, ZoomOut } from "lucide-react";
import { scannerStatusMessage, RELEVANT_BARCODE_FORMATS, type CameraFeatures } from "@/lib/barcode-scanner/support";
import {
  startScanSession,
  type ScanMode,
  type ScanPhase,
  type ScanSession,
  type StreamLike,
} from "@/lib/barcode-scanner/session";
import { createBarcodeDecoder, loadZXingDetector, type NativeDetectorCtor } from "@/lib/barcode-scanner/decoder";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const INITIAL_PHASE: ScanPhase = { kind: "checking" };
const NO_FEATURES: CameraFeatures = { continuousFocus: false, zoom: null, torch: false };

/**
 * Camera barcode scanning — an ADDITIONAL input method next to the existing
 * text field, never a replacement: a hardware keyboard-wedge scanner or
 * manual typing keeps working unchanged, since this component never touches
 * that field — it only calls `onDetect(code)` with what the camera read,
 * exactly as if the operator had typed it. The caller feeds the code into
 * its own existing search; nothing here creates a sale/reception line,
 * moves stock or writes anything.
 *
 * Reading is automatic; « Scanner maintenant » decodes the current frame on
 * demand. `mode="continuous"` keeps the camera open for several articles
 * (the same code is ignored for a moment); the default single mode closes on
 * the first code, as before. Torch and zoom buttons appear ONLY when the
 * camera reports them (src/lib/barcode-scanner/support.ts#cameraFeaturesFrom).
 *
 * Decoder: the browser's native `BarcodeDetector` when usable, otherwise
 * the self-hosted ZXing WebAssembly decoder loaded on first open
 * (src/lib/barcode-scanner/decoder.ts) — iPhone/iPad, Firefox. The lifecycle lives in
 * src/lib/barcode-scanner/session.ts (unit-tested with fakes): camera
 * requested only after the user opens the dialog, camera always released on
 * detection (single mode), close, error and unmount.
 */
export function BarcodeScanButton({
  onDetect,
  label = "Scanner",
  mode = "single",
}: {
  onDetect: (code: string) => void;
  label?: string;
  /** "continuous": stays open for several codes until « Terminer ». Default "single" (closes on the first code). */
  mode?: ScanMode;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<ScanPhase>(INITIAL_PHASE);
  const [features, setFeatures] = useState<CameraFeatures>(NO_FEATURES);
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [scanned, setScanned] = useState<string[]>([]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<ScanSession | null>(null);
  // Latest callback without restarting the camera when the parent re-renders
  // (callers pass inline functions).
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    if (!open) return;
    const session = startScanSession({
      mode,
      env: {
        isSecureContext: typeof window !== "undefined" ? window.isSecureContext : undefined,
        hasBarcodeDetector: typeof window !== "undefined" && "BarcodeDetector" in window,
        hasWebAssembly: typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function",
        hasMediaDevices: typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia),
      },
      // The DOM types don't list the device-specific capabilities (focusMode,
      // zoom, torch) — the session reads them defensively, so the real
      // MediaStream is used through the narrower StreamLike shape.
      getUserMedia: async (constraints) =>
        (await navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints)) as unknown as StreamLike,
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
      onFeatures: (f) => {
        setFeatures(f);
        setZoom(f.zoom ? f.zoom.min : null);
      },
      onDetect: (code) => {
        // Haptic confirmation where supported (Android); silently ignored elsewhere.
        try {
          navigator.vibrate?.(60);
        } catch {
          // ignore
        }
        onDetectRef.current(code);
        setHint(null);
        if (mode === "continuous") setScanned((p) => [code, ...p].slice(0, 5));
        else setOpen(false);
      },
    });
    sessionRef.current = session;
    return () => {
      session.stop();
      sessionRef.current = null;
    };
  }, [open, mode]);

  async function scanNow() {
    const result = await sessionRef.current?.scanNow();
    if (result === "none") setHint("Aucun code lu sur cette image. Éloignez légèrement le téléphone, centrez le code et réessayez.");
    else if (result === "duplicate") setHint("Ce code vient déjà d'être lu.");
    else if (result === "busy") setHint("Lecture en cours…");
    else setHint(null);
  }

  async function toggleTorch() {
    const next = !torchOn;
    if (await sessionRef.current?.setTorch(next)) setTorchOn(next);
  }

  async function stepZoom(direction: 1 | -1) {
    if (!features.zoom || zoom === null) return;
    const { min, max } = features.zoom;
    const step = Math.max(features.zoom.step, (max - min) / 8);
    const next = Math.min(max, Math.max(min, zoom + direction * step));
    if (await sessionRef.current?.setZoom(next)) setZoom(next);
  }

  const message =
    phase.kind === "unsupported"
      ? scannerStatusMessage(phase.reason)
      : phase.kind === "error"
        ? scannerStatusMessage(phase.errorKind)
        : null;
  const scanning = phase.kind === "scanning";

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
          setFeatures(NO_FEATURES);
          setTorchOn(false);
          setZoom(null);
          setHint(null);
          setScanned([]);
          setOpen(true);
        }}
      >
        <Camera className="size-4" />
        {label}
      </Button>
      <DialogContent className="max-h-[95dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scanner un code-barres</DialogTitle>
          <DialogDescription>
            Placez le code-barres dans le cadre, bien éclairé. Si l&apos;image est floue, éloignez légèrement le
            téléphone : la lecture est automatique, ou touchez « Scanner maintenant ».
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
          <div className="relative aspect-[4/3] max-h-[55dvh] w-full overflow-hidden rounded-md bg-black">
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
            {scanning && (
              <>
                {/* A wide, short band: the shape of a 1D barcode. Guidance only — the whole image is decoded. */}
                <div className="pointer-events-none absolute inset-x-[8%] top-1/2 h-[38%] -translate-y-1/2 rounded-lg border-2 border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" aria-hidden="true" />
                <p className="absolute inset-x-0 bottom-2 px-2 text-center text-xs text-white/90" role="status">
                  {mode === "continuous" && scanned.length > 0 ? `Dernier code : ${scanned[0]}` : "Recherche d'un code-barres…"}
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

        {scanning && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" className="flex-1" onClick={() => void scanNow()}>
              <ScanLine className="size-4" />
              Scanner maintenant
            </Button>
            {features.zoom && (
              <>
                <Button type="button" variant="outline" size="icon" aria-label="Dézoomer" onClick={() => void stepZoom(-1)} disabled={zoom === null || zoom <= features.zoom.min}>
                  <ZoomOut className="size-4" />
                </Button>
                <Button type="button" variant="outline" size="icon" aria-label="Zoomer" onClick={() => void stepZoom(1)} disabled={zoom === null || zoom >= features.zoom.max}>
                  <ZoomIn className="size-4" />
                </Button>
              </>
            )}
            {features.torch && (
              <Button
                type="button"
                variant={torchOn ? "default" : "outline"}
                size="icon"
                aria-label={torchOn ? "Éteindre la lampe" : "Allumer la lampe"}
                aria-pressed={torchOn}
                onClick={() => void toggleTorch()}
              >
                {torchOn ? <FlashlightOff className="size-4" /> : <Flashlight className="size-4" />}
              </Button>
            )}
          </div>
        )}
        {hint && (
          <p className="text-xs text-amber-700 dark:text-amber-400" role="status">
            {hint}
          </p>
        )}
        {mode === "continuous" && scanned.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {scanned.length} code{scanned.length > 1 ? "s" : ""} lu{scanned.length > 1 ? "s" : ""} — continuez, ou touchez « Terminer ».
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          La saisie manuelle et les scanners USB/Bluetooth restent utilisables à tout moment.
        </p>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          {mode === "continuous" ? "Terminer" : "Fermer"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
