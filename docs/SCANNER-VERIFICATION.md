# Barcode scanner — verification and troubleshooting

What the code guarantees, what the automated tests prove, and the steps
that still need a physical device (HENEX keyboard-wedge scanner, phone camera).

## How a code reaches a product

| Step | Where | What happens |
|---|---|---|
| Label | `src/components/products/printable-label.tsx` | 50 × 30 mm. **Bars** = Code 128 of the unit's official barcode (as stored) or, without one, its SKU ("CODE INTERNE"). **QR** = `https://<app>/scan/<token>` (public product page), **not** the SKU or barcode. The text under the bars is exactly the value in the bars. |
| Keyboard scanner | sale, reception, packing, returns, traçabilité fields | The scanner types characters + Enter. The field is emptied immediately; Enter on an empty field does nothing (CR+LF is safe). |
| Camera | `BarcodeScanButton` | Lookup screens: linear formats + `qr_code`. Barcode entry fields (product form, identity) and the parcel returns workspace: linear formats only. |
| Lookup | `src/lib/catalog/lookup.ts` | Tenant-scoped. 0) ASODITECH label QR → its article by token · 1) exact barcode (then case-insensitive / UPC-A↔EAN-13↔GTIN-14, accepted only if exactly one) · 2) exact SKU (case-insensitive) · 3) partial (search screens only). |
| Feedback | `src/lib/catalog/scan-input.ts` | « Code inconnu » always shows the **received code** plus a hint when the code looks garbled (keyboard layout, AIM prefix, web QR, bad EAN check digit, spaces). The sale screen also says when the code designates an article that is archived / disabled / not on the channel. |

## Automated (no device)

- `tests/lib/label-scan-compat.test.ts` — the label's Code 128 and QR rendered from the same encoders and decoded by the real self-hosted ZXing WASM: plain, ×3 wide, ×6 tall, framed (read); no quiet zone + frame against the bars (not read); QR only read when `qr_code` is requested; EAN-13 with leading 0; module widths.
- `tests/lib/scan-input.test.ts` — label-URL parsing, layout / AIM / check-digit / URL hints.
- `tests/lib/catalog-lookup.test.ts`, `tests/lib/exact-code.test.ts`, `tests/actions/return-scan.test.ts` — DB tests (need the test database).

## Manual — HENEX keyboard-wedge scanner

1. Open Notepad (Windows) / TextEdit (Mac). Scan an EAN-13 product (e.g. `611…`).
   - Exact digits followed by a new line → OK, go to 3.
   - `&é"'(-è_çà`-style characters → scanner is QWERTY, computer AZERTY: scan the manual's **Keyboard language: French (AZERTY)** setup code (or set the computer to the scanner's layout).
   - Starts with `]E0`, `]C1`… → disable **AIM ID / Code ID** prefix.
   - No new line → set the **suffix to CR (Enter)**. A Tab suffix moves the focus away instead of submitting.
2. Scan the ASODITECH label's **bars** in Notepad: must equal the text printed under the bars. Scan its **QR**: a 2D scanner types `https://…/scan/…` (a 1D-only scanner reads nothing).
3. In the app, POS (`/ventes/nouvelle`): scan the bars, then the QR, of a product enabled on the channel with stock → added each time. Scan 5 labels quickly → 5 lines/quantities, no merged codes.
4. Repeat 3 in the reception, packing and returns screens.

## Manual — phone camera

1. Open the app over **https** (camera is blocked on plain http). « Caméra » on the POS.
2. Point at the label's bars, then at its QR → same article. Then a retail EAN-13.
3. Product form « Scanner » (barcode field): the QR must be ignored (linear only).

## Evidence to collect when something fails

Scanner model and mode (USB / Bluetooth HID / virtual COM), computer OS + keyboard layout, the exact screen,
the raw text the scanner types into Notepad for the failing code, a photo of the failing label/barcode,
and the full message the app showed (it now includes the received code).

## Label limits (from the layout code)

- Bars area 47 mm. Module width ≥ 0.25 mm up to ~12 characters of SKU; at 13+ characters (e.g. `TEST-RETOUR-1` ≈ 0.24 mm, 17 characters ≈ 0.19 mm) the label page warns — use a shorter SKU or the supplier barcode. An EAN-13 prints at ≈ 0.33 mm.
- Official EAN/UPC barcodes are printed in **Code 128** (same digits, not the EAN-13 symbology): the scanner must have Code 128 enabled (default on most models).
- QR: 12 mm, ≈ 0.32 mm modules for the production URL, 4-module quiet zone respected.
