# ADR 0054 — Product CSV export (WooCommerce / Shopify) and product lifecycle

## Status
Accepted (2026-10-02). No schema change, no migration, no new permission.
Builds on ADR 0038 (catalogue identity), 0036 (ASODITECH is the stock
authority), Batch 13 (direct « Publier »).

## Context
A supplier delivers many products at once. They are created in ASODITECH and
must then exist in the merchant's WooCommerce or Shopify store without
retyping them. This is a **controlled CSV export**: ASODITECH never creates
anything in a store here (no API call, no sync, no webhook).

## Decision — export
`/produits` → « Exporter CSV » → `/produits/exporter`:
1. **Filter.** Search (name, SKU, reference, barcode, variation SKU), status,
   category, simple / with variations, in stock / out of stock, created
   between, origin, and "not yet published to WooCommerce / Shopify".
   - Default: **active products created in ASODITECH**. Inactive (archived),
     draft and store-imported products appear only when asked for.
   - At most 1 000 rows are listed.
   - No supplier filter: a product has no supplier in the domain (suppliers
     are linked through receptions only).
2. **Select** rows, or all filtered rows.
3. **Choose the platform.**
4. **Verify** (`validateProductExportAction`).
5. **Download** (`POST /produits/exporter/{woocommerce|shopify}`).

Verify and download run the same `prepareProductExport` (load → validate →
build), so the downloaded file is exactly the one that was validated. At most
500 products per file.

Platform-specific builders — never one generic CSV:
- **WooCommerce** (`src/lib/catalog/export/woocommerce.ts`). Built-in importer
  schema (WooCommerce wiki « Product CSV Import Schema »).
  - Products:
    - a simple product is one `simple` row;
    - a variable product is one `variable` parent row carrying every attribute
      and all its values, then one `variation` row per active variation, with
      `Parent` = the parent's SKU.
  - Fields:
    - `Images`: comma-separated, the first is featured;
    - `Categories`: `Parent > Child`, with commas escaped as `\,`;
    - barcode → `GTIN, UPC, EAN, or ISBN`;
    - attributes are product-level (`global` = 0);
    - `Published`: active = 1, draft or archived = -1.
- **Shopify** (`src/lib/catalog/export/shopify.ts`). Current Shopify template
  headers.
  - Rows:
    - one row per variant, all sharing the `URL handle`;
    - product fields and option names only on the first row;
    - extra images on handle-only rows;
    - a product without variations becomes `Title` / `Default Title`.
  - Fields:
    - `Status`: active / draft / archived;
    - barcode → `Barcodes`;
    - an ASODITECH promotion maps to `Price` (sale) and `Compare-at price`
      (regular).

Never exported:
- **Stock quantities.** ASODITECH stays the stock authority; a quantity in a
  file would be stale on import.
- **Purchase cost** (finance data).
- **Inactive variations.**

File format: UTF-8 without BOM, RFC 4180 quoting, CRLF, deterministic order
(name, then SKU) and deterministic names:
- `asoditech-woocommerce-products-YYYY-MM-DD.csv`
- `asoditech-shopify-products-YYYY-MM-DD.csv`

Values are written exactly. There is no spreadsheet formula guard: the file is
meant for a platform importer, where a prefix would corrupt the merchant's
text.

## Category compatibility (smallest safe mechanism)
- **WooCommerce.** A category synced from the connected WooCommerce store
  (`source = WOOCOMMERCE`) is known to exist there. Any other category gets a
  pre-export warning: WooCommerce will create it if no category has that exact
  name.
- **Shopify.** « Product category » expects Shopify's Standard Product
  Taxonomy, which an ASODITECH category cannot be verified against. It is left
  blank, and the ASODITECH category goes to « Type » (free text), with a
  warning.

No category mapping table was added.

## Validation
- **Blocking:**
  - empty selection;
  - missing name, SKU or price;
  - a duplicate SKU in the file;
  - a product imported from, or already published to, that platform;
  - a variable product with no active variation;
  - for Shopify: more than 3 options, or an incomplete or duplicated variant
    combination;
  - an id that does not resolve in the caller's tenant (never a partial file).
- **Warnings** (must be acknowledged before downloading):
  - unverifiable category, no image, non-public image URL (skipped);
  - draft or deactivated product, inactive variations skipped;
  - sale price ≥ price (ignored);
  - stock not exported;
  - a connected store (see Limitations).

## Authorization
`products.edit` — the existing « manage the catalogue » permission — on the
page, the validation action and the download route. All three check it
server-side. Loading goes through the tenant-scoped client and RLS, and every
download is audited (`product.exported`).

## Decision — lifecycle
The existing `ProductStatus` is reused: `ACTIF` ⇄ `ARCHIVE` (« désactivé »);
`BROUILLON` is unchanged. Variations already have `isActive`.
`setProductActiveAction` (`products.edit`, audited) and the « Désactiver /
Réactiver » button are the normal lifecycle action. For a store-imported
product it is refused, because the store sync owns its status.

Already enforced server-side, unchanged: a new order or POS sale refuses a
product that is not `ACTIF` and an inactive variation. An archived product
stays searchable, visible with its badge, and in every report.

Hard delete (`removeProductAction`, pre-existing): it deleted a product with
no order line and no stock movement. It now **archives instead** when the
product or any of its variations is referenced by an order line, a POS sale
line, a reception line (a draft has no movement yet) or a store publication.
Only a product with no history at all is still deleted.

## Limitations (reported, not worked around)

> **Update:** the duplicate-on-sync limitation below is fixed by ADR 0055 (identity reconciliation by publication / SKU).
- **Duplicates on sync with a connected store.** WooCommerce/Shopify product
  sync matches products by `(source, externalId)` only. A product created in
  the store by importing this CSV is not linked to its ASODITECH product, so
  the next product sync or « product created » webhook imports it as a new
  ASODITECH product with a suffixed SKU. The same gap exists for direct
  « Publier » (the sync does not read `ProductPublication`). The export warns
  whenever the store is connected. Fixing it means linking by SKU in the sync,
  a separate decision.
- **Images must be publicly downloadable.** Images are stored as URLs (store
  CDNs or pasted links), never as files. A URL that is not public http(s) is
  skipped with a warning.
- **Shopify « Product category » must be chosen in Shopify** after import.
