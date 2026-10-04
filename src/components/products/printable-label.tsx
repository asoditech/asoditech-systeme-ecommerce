"use client";

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import QRCode from "qrcode";
import { Printer, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INTERNAL_CODE_CAPTION, labelBarcode } from "@/lib/catalog/label-barcode";
import {
  CODE128_QUIET_ZONE_MODULES,
  LABEL_LINE_HEIGHT,
  LABEL_MM,
  LABEL_NAME_MAX_LINES,
  LABEL_TEXT_PT,
  MIN_MODULE_MM,
  MIN_QR_MODULE_MM,
  QR_ERROR_CORRECTION,
  labelBarcodeFit,
  labelQrFit,
} from "@/lib/catalog/label-layout";

/**
 * The printable sticker — docs/adr/0042 — laid out for a physical
 * 50 mm × 30 mm label as ONE compact block (src/lib/catalog/label-layout.ts,
 * whose space budget is checked by tests): QR + product identity on top, the
 * linear barcode across the full width right below. Barcode (operational,
 * internal scanning) and QR (public, opens `scanUrl` on any phone camera)
 * serve different purposes and both render. Both are inline SVG — crisp at
 * any printer DPI.
 *
 * Linear barcode = the unit's official (supplier/customer-entered) Barcode,
 * or — when it has none — its SKU as a Code 128 INTERNAL code, captioned as
 * not being an EAN/GTIN and never stored (src/lib/catalog/label-barcode.ts).
 *
 * The sheet is sized in mm and printed through the label page's own
 * stylesheet (`LABEL_PRINT_CSS`), never the A4 report rules.
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
  const fit = encoded ? labelBarcodeFit(encoded) : null;
  const qrFit = labelQrFit(scanUrl);

  useEffect(() => {
    if (!encoded || !barcodeRef.current) return;
    try {
      // 1 unit per module + the mandatory quiet zones; the SVG is then stretched
      // by CSS to the label's inner width (viewBox), so every module scales
      // equally — exactly the width labelBarcodeFit() reports.
      // The human-readable text is rendered in HTML below (never stretched).
      JsBarcode(barcodeRef.current, encoded, {
        format: "CODE128",
        width: 1,
        height: 40,
        margin: 0,
        marginLeft: CODE128_QUIET_ZONE_MODULES,
        marginRight: CODE128_QUIET_ZONE_MODULES,
        displayValue: false,
      });
      barcodeRef.current.removeAttribute("width");
      barcodeRef.current.removeAttribute("height");
      barcodeRef.current.setAttribute("preserveAspectRatio", "none");
    } catch {
      // A value outside Code128's alphabet is essentially unreachable (it
      // covers full ASCII) — fail soft rather than crash the print page.
    }
  }, [encoded]);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(scanUrl, { type: "svg", margin: 0, errorCorrectionLevel: QR_ERROR_CORRECTION }).then((svg) => {
      if (!cancelled) setQrSvg(svg);
    });
    return () => {
      cancelled = true;
    };
  }, [scanUrl]);

  const mm = (n: number) => `${n}mm`;
  const text = (pt: number) => ({ fontSize: `${pt}pt`, lineHeight: LABEL_LINE_HEIGHT });

  return (
    <div className="space-y-4">
      <div
        data-label-sheet
        className="flex flex-col overflow-hidden rounded-md border bg-white text-black shadow-sm"
        style={{ width: mm(LABEL_MM.width), height: mm(LABEL_MM.height), padding: mm(LABEL_MM.padding), boxSizing: "border-box" }}
      >
        <div className="flex items-start" style={{ gap: mm(LABEL_MM.qrTextGap), height: mm(LABEL_MM.qr) }}>
          {qrSvg ? (
            <div
              className="shrink-0 [&>svg]:block [&>svg]:size-full"
              style={{ width: mm(LABEL_MM.qr), height: mm(LABEL_MM.qr) }}
              aria-label="QR code de l'article"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <div className="shrink-0 animate-pulse bg-neutral-200" style={{ width: mm(LABEL_MM.qr), height: mm(LABEL_MM.qr) }} aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1 overflow-hidden" style={{ maxHeight: mm(LABEL_MM.qr) }}>
            <p className="font-semibold break-words" style={{ ...text(LABEL_TEXT_PT.name), WebkitLineClamp: LABEL_NAME_MAX_LINES, display: "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {productName}
            </p>
            {variantLabel && (
              <p className="truncate" style={text(LABEL_TEXT_PT.variant)}>
                {variantLabel}
              </p>
            )}
            <p className="truncate font-mono" style={text(LABEL_TEXT_PT.sku)}>
              SKU {sku}
            </p>
          </div>
        </div>

        <div className="flex min-h-0 flex-col items-center" style={{ marginTop: mm(LABEL_MM.rowGap) }}>
          {encoded ? (
            <>
              <svg
                ref={barcodeRef}
                role="img"
                aria-label={linear.kind === "internal" ? `Code interne ${encoded} (pas un EAN/GTIN)` : `Code-barres ${encoded}`}
                style={{ display: "block", width: "100%", height: mm(LABEL_MM.barcodeHeight) }}
              />
              <p className="w-full truncate text-center font-mono" style={{ ...text(LABEL_TEXT_PT.value), marginTop: mm(LABEL_MM.valueGap) }}>
                {encoded}
              </p>
              {linear.kind === "internal" && (
                <p className="w-full truncate text-center font-semibold tracking-wide" style={text(LABEL_TEXT_PT.caption)}>
                  {INTERNAL_CODE_CAPTION}
                </p>
              )}
            </>
          ) : (
            <p className="flex items-center gap-1 text-amber-700" style={text(LABEL_TEXT_PT.sku)}>
              <TriangleAlert className="size-2.5 shrink-0" />
              Aucun code-barres pour cet article.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2 print:hidden">
        {fit && !fit.legible && (
          <p role="status" className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            Code-barres trop long pour une lecture fiable sur {LABEL_MM.width} mm (barres de {fit.moduleMm.toFixed(2)} mm,
            minimum conseillé {MIN_MODULE_MM} mm). Raccourcissez le SKU ou ajoutez le code-barres fournisseur.
          </p>
        )}
        {qrFit && !qrFit.legible && (
          <p role="status" className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            QR très dense pour {LABEL_MM.qr} mm (modules de {qrFit.moduleMm.toFixed(2)} mm, minimum conseillé{" "}
            {MIN_QR_MODULE_MM} mm) : sa lecture au téléphone peut être difficile.
          </p>
        )}
        <Button type="button" onClick={() => window.print()}>
          <Printer className="size-4" />
          Imprimer
        </Button>
        <p className="text-xs text-muted-foreground">
          Étiquette de {LABEL_MM.width} × {LABEL_MM.height} mm, affichée à sa taille réelle. Dans la fenêtre
          d&apos;impression : papier {LABEL_MM.width} × {LABEL_MM.height} mm (format de l&apos;imprimante
          d&apos;étiquettes), échelle 100 % / taille réelle, marges « Aucune », en-têtes et pieds de page désactivés.
          Testez la lecture du code-barres et du QR sur une première étiquette imprimée.
        </p>
        {linear.kind === "internal" && (
          <p className="text-xs text-muted-foreground">
            Sans code-barres fournisseur, l&apos;étiquette imprime le SKU en code interne (lisible par le scanner de
            l&apos;application, pas un EAN/GTIN). Si l&apos;article a un vrai code-barres, ajoutez-le dans l&apos;onglet
            Identité : il remplacera le code interne.
          </p>
        )}
        {linear.kind === "none" && (
          <p className="text-xs text-muted-foreground">
            Le QR fonctionne déjà — ajoutez un code-barres principal dans l&apos;onglet Identité pour une étiquette
            complète.
          </p>
        )}
      </div>
    </div>
  );
}
