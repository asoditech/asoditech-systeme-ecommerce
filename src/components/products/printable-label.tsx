"use client";

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import { Printer, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The actual printable sticker — docs/adr/0042. Barcode (operational,
 * internal scanning) and QR (public, opens `scanUrl` on any phone camera)
 * serve DIFFERENT purposes and both render here, side by side, never one
 * replacing the other. Both are drawn client-side as inline SVG — crisp at
 * any print DPI, no server round-trip, no PDF dependency (browser print CSS
 * only, `[data-print-sheet]` reuses the same print-flattening rule the
 * report pages already define in globals.css).
 */
export function PrintableLabel({
  productName,
  variantLabel,
  sku,
  barcode,
  scanUrl,
}: {
  productName: string;
  variantLabel: string | null;
  sku: string;
  barcode: string | null;
  scanUrl: string;
}) {
  const barcodeRef = useRef<SVGSVGElement>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  useEffect(() => {
    if (!barcode || !barcodeRef.current) return;
    try {
      JsBarcode(barcodeRef.current, barcode, { format: "CODE128", displayValue: true, fontSize: 12, height: 40, margin: 4 });
    } catch {
      // A value outside Code128's alphabet is essentially unreachable (it
      // covers full ASCII) — fail soft rather than crash the print page.
    }
  }, [barcode]);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(scanUrl, { type: "svg", margin: 1, width: 152 }).then((svg) => {
      if (!cancelled) setQrSvg(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [scanUrl]);

  return (
    <div className="space-y-4">
      <div data-print-sheet className="rounded-xl border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{productName}</p>
            {variantLabel && <p className="text-xs text-muted-foreground">{variantLabel}</p>}
            <p className="mt-1 font-mono text-xs text-muted-foreground">SKU {sku}</p>
          </div>
          {qrSvg ? (
            <div className="shrink-0" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          ) : (
            <div className="size-[152px] shrink-0 animate-pulse rounded bg-muted" aria-hidden="true" />
          )}
        </div>
        <div className="mt-3 flex min-h-12 items-center justify-center">
          {barcode ? (
            <svg ref={barcodeRef} role="img" aria-label={`Code-barres ${barcode}`} />
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="size-3.5 shrink-0" />
              Aucun code-barres pour cet article.
            </p>
          )}
        </div>
      </div>

      <div className="print:hidden">
        <Button type="button" onClick={() => window.print()}>
          <Printer className="size-4" />
          Imprimer
        </Button>
        {!barcode && (
          <p className="mt-2 text-xs text-muted-foreground">
            Le QR fonctionne déjà — ajoutez un code-barres principal dans l&apos;onglet Identité pour une étiquette
            complète.
          </p>
        )}
      </div>
    </div>
  );
}
