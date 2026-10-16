# ADR 0061 — Automatic product / variation barcode generation

Status: Accepted — implemented locally 2026-10-15 (not committed, not deployed).

## Context
The owner's requirement is automatic barcodes for PRODUCTS and VARIATIONS
(ADR 0060's customer codes came from a misread of it; they are kept, see below).
What existed before: the `Barcode` table (`@@unique([tenantId, code])`, one
owner — product XOR variation, so products and variations share one namespace
per tenant), opaque codes (3–64 chars), manual entry by typing / keyboard
scanner / camera (`RELEVANT_BARCODE_FORMATS`: EAN-13/8, UPC-A/E, Code 128,
Code 39, ITF, Codabar), a non-blocking GS1 check-digit hint, a GTIN-equivalent
lookup fallback, Code 128 labels, no generator. Barcodes exist only for
`catalogIdentity` (« En ligne + Magasin ») tenants.

## Decisions
- **Format** — an EAN-13-shaped GS1 Restricted Circulation Number:
  `20` + 10-digit tenant sequence + GS1 mod-10 check digit
  (`formatGeneratedProductBarcode`). Reasons from the existing code: 13 digits
  with a valid check digit pass `gs1CheckDigitWarning`; the camera reads it as
  `ean_13`; labels encode it as Code 128 like every stored code; all-digit codes
  keep the AZERTY/QWERTY scan hint; starting with `2` it can never be a
  GTIN-equivalent spelling of a stored UPC/GTIN-14. Stored as a string (inner
  zeros preserved). Not a GTIN: GS1 reserves 20–29 for internal use.
- **Uniqueness scope** — unchanged: per tenant, products and variations
  together, enforced by the existing unique index on `barcodes`. Allocation
  adds a first line of defence: `Tenant.nextProductBarcodeNumber` is claimed by
  an atomic increment (tenant row lock until commit), and a number whose code
  is already a barcode (exact or GTIN-equivalent) or a product / variation SKU
  is skipped. Never reused, never reset.
- **Setting** — `BusinessSettings.productBarcodeAutoEnabled` (default false),
  Paramètres → Stock, `settings.manage`; turning it on needs `catalogIdentity`;
  audited `settings.updated`. Off: manual entry exactly as before; « Générer »
  hidden and refused server-side.
- **Where** — « Générer » next to the barcode field of the product create form,
  and next to EACH unit's barcode input in the Identité tab (simple product, or
  every variation); a non-empty field is replaced only after confirmation;
  nothing is saved until the normal save (« Enregistrer » / « Ajouter »). The
  variation generator has « Générer un code-barres pour chaque nouvelle
  variation »: each NEW variation gets its own code in the creation transaction;
  existing variations are untouched.
- **Action** — `generateProductBarcodeAction` (products.create or products.edit +
  catalogIdentity + setting) only hands out a code; a code never saved is not
  reused (gaps are expected).
- **Export / label** — generated codes are not GTINs: the store CSV export
  leaves the GTIN / Barcodes column empty for them (`exportableBarcode`); the
  label prints them captioned « CODE INTERNE — PAS UN EAN/GTIN ».
- **Backup / restore** — codes restore as is; the counter moves past the
  highest restored `20…` code.
- **ADR 0060 correction** — the « `CL-` + digits » reservation of product SKUs
  / barcodes is removed (not needed: product lookups never resolve customer
  codes, and the customer generator skips numbers used by product
  identifiers). Customer codes themselves are unchanged.

## Product selection across the app (addendum 2026-10-15)
One exact-code resolver for every picker: `resolveExactCode`
(src/lib/catalog/exact-code.ts → `lookupSellableUnits`): label QR, exact
barcode (incl. generated codes, letter case, GTIN spellings), exact variation /
simple-product SKU — one unit or nothing; a parent SKU stays ambiguous.
| Workflow | Search | Exact code → unit | Camera |
|---|---|---|---|
| Order (create) — `searchProductsForOrderAction` | name, SKU, reference, variation SKU, option values, barcode | **now** via the shared resolver (a variation's code offers that variation only; inactive / archived → nothing) | **added** |
| In-store sale — `lookupForSaleAction` | shared engine | already | already |
| Reception — `lookupSellableUnitsAction` | shared engine | already | already |
| Traceability — `lookupSellableUnits` | shared engine | already | already |
| Transfer — source-stock picker | name, SKU (client filter) | **added**: Enter / camera → `resolveTransferCodeAction`; the picker now stays open for several articles | **added** |
| Stocktake count — line finder | name, SKU filter **added** | **added**: `findStocktakeLineByCodeAction` focuses the line | **added** |
| Packing / returns verification | exact only (by design) | already (`resolveExactCode`) | already |
Not a free product choice (lines come from the document): stock adjustment
(opened on one stock row), return inspection, sale returns.
Customer codes live in `customers.barcode`, never in `barcodes`: no product
picker can resolve them.

## Not applicable (no such workflow in the repo)
Product duplication, product CSV import (only exports exist), store-side barcode
sync (WooCommerce / Shopify product sync never writes barcodes).

## Release status (2026-10-15)
| Item | Status |
|---|---|
| Generation, setting, UI, export/label/backup handling | Implemented; unit + DB tests on the local test DB |
| Migration `20261015140000_product_barcode_generation` | Created; applied ONLY to the local disposable test DB; not to the local dev DB, Preview or Production |
| Live scanner check | Not done (needs a printed label and the HENEX scanner) |
