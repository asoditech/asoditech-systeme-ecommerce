import JsBarcode from "jsbarcode";
import QRCode from "qrcode";

/**
 * Physical product label: 50 mm × 30 mm (src/components/products/printable-label.tsx,
 * page src/app/(protected)/produits/[id]/etiquette/page.tsx). Everything on the
 * label is sized in millimetres / points from these constants, and the space
 * budget below is checked by tests, so the printed output fits the sticker
 * independently of screen pixels and of A4 report printing.
 *
 * Layout — one block, top to bottom inside the padding:
 *   ┌───────────────────────────────────────────────┐
 *   │ [QR 12 mm]  Name (2 lines max)                 │
 *   │             Variant                            │
 *   │             SKU …                              │
 *   │ ▌▌▌ ▌▌ ▌▌▌▌ ▌ ▌▌▌ (Code 128, full inner width) │
 *   │           value · CODE INTERNE caption         │
 *   └───────────────────────────────────────────────┘
 */
export const LABEL_MM = {
  width: 50,
  height: 30,
  /** Inner margin on every side. */
  padding: 1.5,
  /** QR code side (top-left). */
  qr: 12,
  /** Horizontal gap between the QR and the text column. */
  qrTextGap: 1.5,
  /** Vertical gap between the QR/text row and the barcode bars. */
  rowGap: 1.5,
  /** Bar height of the linear barcode. */
  barcodeHeight: 8,
  /** Gap between the bars and the human-readable value. */
  valueGap: 0.4,
} as const;

/** Font sizes (pt) of each text line, and the shared line-height factor. */
export const LABEL_TEXT_PT = {
  name: 6.5,
  variant: 6,
  sku: 6,
  value: 5.5,
  caption: 4.5,
} as const;
export const LABEL_LINE_HEIGHT = 1.15;
/** The product name wraps to at most this many lines (then ellipsis). */
export const LABEL_NAME_MAX_LINES = 2;

const PT_MM = 25.4 / 72;
const lineMm = (pt: number) => pt * PT_MM * LABEL_LINE_HEIGHT;

export const LABEL_INNER_MM = {
  width: LABEL_MM.width - 2 * LABEL_MM.padding,
  height: LABEL_MM.height - 2 * LABEL_MM.padding,
} as const;

/** Width available to the linear barcode: the full inner width (quiet zones included). */
export const LABEL_BARCODE_WIDTH_MM = LABEL_INNER_MM.width;
/** Width of the text column next to the QR. */
export const LABEL_TEXT_WIDTH_MM = LABEL_INNER_MM.width - LABEL_MM.qr - LABEL_MM.qrTextGap;

/**
 * Vertical space budget of the worst case (2-line name, variant, SKU, value
 * AND internal-code caption). Must stay ≤ the inner height — asserted by tests.
 */
export function labelHeightBudget() {
  const text = LABEL_NAME_MAX_LINES * lineMm(LABEL_TEXT_PT.name) + lineMm(LABEL_TEXT_PT.variant) + lineMm(LABEL_TEXT_PT.sku);
  const top = Math.max(LABEL_MM.qr, text);
  const bottom =
    LABEL_MM.rowGap + LABEL_MM.barcodeHeight + LABEL_MM.valueGap + lineMm(LABEL_TEXT_PT.value) + lineMm(LABEL_TEXT_PT.caption);
  return { text, top, bottom, total: top + bottom, available: LABEL_INNER_MM.height };
}

/** Code 128 needs a blank quiet zone of at least 10 modules on each side. */
export const CODE128_QUIET_ZONE_MODULES = 10;

/**
 * Narrowest bar module considered reliably scannable on a small thermal label
 * (a common conservative X-dimension: 2 dots of a 203 dpi printer). Below
 * this the label shows a warning. A value at or above it is NOT a guarantee —
 * only a physical print + scan test proves readability.
 */
export const MIN_MODULE_MM = 0.25;

/** Number of bar modules JsBarcode emits for `value` as Code 128 (quiet zones excluded); null if not encodable. */
export function code128ModuleCount(value: string): number | null {
  const out: { encodings?: { data: string }[] } = {};
  try {
    JsBarcode(out, value, { format: "CODE128" });
  } catch {
    return null;
  }
  const modules = (out.encodings ?? []).reduce((n, e) => n + e.data.length, 0);
  return modules > 0 ? modules : null;
}

export interface BarcodeFit {
  modules: number;
  /** Printed width of one module: the SVG viewBox (modules + both quiet zones) is stretched to the barcode width. */
  moduleMm: number;
  legible: boolean;
}

/** How wide each bar module prints for `value` on the label; null if the value cannot be encoded. */
export function labelBarcodeFit(value: string): BarcodeFit | null {
  const modules = code128ModuleCount(value);
  if (modules === null) return null;
  const moduleMm = LABEL_BARCODE_WIDTH_MM / (modules + 2 * CODE128_QUIET_ZONE_MODULES);
  return { modules, moduleMm, legible: moduleMm >= MIN_MODULE_MM };
}

/** QR error-correction level — shared by the rendering and the fit calculation. */
export const QR_ERROR_CORRECTION = "M" as const;
/** A QR symbol needs a 4-module blank margin around it. */
export const QR_QUIET_ZONE_MODULES = 4;
/** Smallest QR module considered comfortable for a phone camera at close range (warning below). */
export const MIN_QR_MODULE_MM = 0.25;

export interface QrFit {
  /** Modules per side of the symbol (no margin: the SVG is rendered with margin 0). */
  modules: number;
  moduleMm: number;
  /** The blank space actually around the symbol (label padding / gaps) covers 4 modules. */
  quietZoneOk: boolean;
  legible: boolean;
}

/** How the QR for `text` prints in the LABEL_MM.qr square; null if it cannot be encoded. */
export function labelQrFit(text: string): QrFit | null {
  let modules: number;
  try {
    modules = QRCode.create(text, { errorCorrectionLevel: QR_ERROR_CORRECTION }).modules.size;
  } catch {
    return null;
  }
  const moduleMm = LABEL_MM.qr / modules;
  const quiet = QR_QUIET_ZONE_MODULES * moduleMm;
  // Left/top: the label padding; right: the gap to the text; bottom: the gap to the bars.
  const quietZoneOk = Math.min(LABEL_MM.padding, LABEL_MM.qrTextGap, LABEL_MM.rowGap) >= quiet;
  return { modules, moduleMm, quietZoneOk, legible: moduleMm >= MIN_QR_MODULE_MM && quietZoneOk };
}

/**
 * Print stylesheet for the label page ONLY. It is rendered by the label page
 * itself (a <style> element present only while that route is mounted), never
 * added to globals.css — so A4 reports, invoices and other print pages keep
 * the global `@page { margin: 14mm }` rule untouched.
 *
 * - `@page` sets the sheet to the physical label size with no margin;
 * - every other element of the app shell is hidden, and the label sheet is
 *   pinned to the top-left corner at its exact millimetre size;
 * - html/body are clamped to one label so nothing spills onto a second page.
 */
export const LABEL_PRINT_CSS = `@media print {
  @page { size: ${LABEL_MM.width}mm ${LABEL_MM.height}mm; margin: 0; }
  html, body {
    width: ${LABEL_MM.width}mm !important;
    height: ${LABEL_MM.height}mm !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    background: #fff !important;
  }
  body * { visibility: hidden !important; }
  [data-label-sheet], [data-label-sheet] * { visibility: visible !important; }
  [data-label-sheet] {
    position: fixed !important;
    left: 0 !important;
    top: 0 !important;
    margin: 0 !important;
    border: none !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}`;
