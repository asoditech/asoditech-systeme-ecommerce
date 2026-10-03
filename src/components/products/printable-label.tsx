"use client";

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import { Printer, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INTERNAL_CODE_CAPTION, labelBarcode } from "@/lib/catalog/label-barcode";

/**
 * The actual printable sticker — docs/adr/0042. Barcode (operational,
 * internal scanning) and QR (public, opens `scanUrl` on any phone camera)
 * serve DIFFERENT purposes and both render here, side by side, never one
 * replacing the other. Both are drawn client-side as inline SVG — crisp at
 * any print DPI, no server round-trip, no PDF dependency (browser print CSS
 * only, `[data-print-sheet]` reuses the same print-flattening rule the
 * report pages already define in globals.css).
 *
 * Linear barcode = the unit's official (supplier/customer-entered) Barcode,
 * or — when it has none — its SKU as a Code 128 INTERNAL code, captioned as
 * not being an EAN/GTIN and never stored (src/lib/catalog/label-barcode.ts).
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
  const linear = labelBarcode({ barcode, sku });
  const encoded = linear.kind === "none" ? null : linear.value;

  useEffect(() => {
    if (!encoded || !barcodeRef.current) return;
    try {
      JsBarcode(barcodeRef.current, encoded, { format: "CODE128", displayValue: true, fontSize: 12, height: 40, margin: 4 });
    } catch {
      // A value outside Code128's alphabet is essentially unreachable (it
      // covers full ASCII) — fail soft rather than crash the print page.
    }
  }, [encoded]);

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
          {linear.kind === "official" ? (
            <svg ref={barcodeRef} role="img" aria-label={`Code-barres ${linear.value}`} />
          ) : linear.kind === "internal" ? (
            <div className="flex flex-col items-center">
              <svg ref={barcodeRef} role="img" aria-label={`Code interne ${linear.value} (pas un EAN/GTIN)`} />
              <p className="text-[10px] font-semibold tracking-wide">{INTERNAL_CODE_CAPTION}</p>
            </div>
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
        {linear.kind === "internal" && (
          <p className="mt-2 text-xs text-muted-foreground">
            Sans code-barres fournisseur, l&apos;étiquette imprime le SKU en code interne (lisible par le scanner de
            l&apos;application, pas un EAN/GTIN). Si l&apos;article a un vrai code-barres, ajoutez-le dans l&apos;onglet
            Identité : il remplacera le code interne.
          </p>
        )}
        {linear.kind === "none" && (
          <p className="mt-2 text-xs text-muted-foreground">
            Le QR fonctionne déjà — ajoutez un code-barres principal dans l&apos;onglet Identité pour une étiquette
            complète.
          </p>
        )}
      </div>
    </div>
  );
}
