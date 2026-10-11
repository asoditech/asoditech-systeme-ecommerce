# Release verification — physical and external checks

Checks that automated tests cannot cover. Run them on **local dev or Preview with
test data only**: no real customer orders, no real customer messages, no live
inventory. Tick a line only after doing it; record the result (OK / KO + what
was seen) next to it.

Scanner details and troubleshooting: `docs/SCANNER-VERIFICATION.md`.

## 0. Before anything

- [ ] Vercel Preview `DATABASE_URL` / `DIRECT_URL` host is NOT the Production host
      (Vercel dashboard → Settings → Environment Variables; the CLI hides
      Sensitive values). Production pooler: `aws-0-eu-central-1`; Preview: `aws-1-eu-west-3`
      (last confirmed 2026-10-07).
- [ ] Pending migrations reviewed: `20261010120000_auth_rate_limits`,
      `20261011120000_return_receptions` (applied by `vercel-build` on push/deploy).

## 1. HENEX scanner — computer (keyboard wedge)

- [ ] Notepad: EAN-13 → exact digits + new line (else: AZERTY setup code, AIM prefix off, CR suffix).
- [ ] Notepad: label bars = text under the bars; label QR = `https://…/scan/…` (2D model only).
- [ ] 5 labels scanned fast in Notepad → 5 separate lines.

| Screen | Route | Bars | QR | 5 fast scans |
|---|---|---|---|---|
| POS | `/ventes/nouvelle` | [ ] | [ ] | [ ] |
| Reception | `/receptions/nouveau` | [ ] | [ ] | [ ] |
| Packing | `/commandes/[id]` (packing panel) | [ ] | [ ] | [ ] |
| Order physical return | `/commandes/[id]` (physical return dialog) | [ ] | [ ] | — |
| Store sale return | sale detail (sale return dialog) | [ ] | [ ] | — |
| Return inspection | `/livraison/retours/inspection/[id]` | [ ] | [ ] | — |
| Traçabilité | `/tracabilite` | [ ] | [ ] | — |
| Parcel returns | `/livraison/retours` | parcel / tracking no. | — (linear only) | — |
| Product barcode field | `/produits/[id]` | [ ] fills field, no submit | — | — |

- [ ] An unknown code shows « Code reçu « … » » (never a scanner error).
- [ ] An archived article / an article not on the channel → the POS says so.

## 2. Phone camera (https only)

- [ ] POS « Caméra »: label bars, label QR, a retail EAN-13 → same article each time.
- [ ] Product form « Scanner »: the QR is ignored, an EAN fills the field.
- [ ] Phone (Android Chrome + iPhone Safari) — note model and browser.

## 3. WooCommerce — development store only

- [ ] New test order on the store → appears once in ASODITECH (no duplicate after webhook retry).
- [ ] Edit that order on the store → existing order updated, not recreated.
- [ ] Cancel in ASODITECH → store status cancelled, stock released once (store and ASODITECH agree).
- [ ] Delivery transition to LIVRE (Suivi refresh) → store order completed.
- [ ] A delivery that fails while processing → the WooCommerce card shows « … n'ont pas pu être traités »; WooCommerce's retry is reprocessed.
- [ ] Wrong webhook secret → deliveries are rejected (401) and NOT recorded (no tenant can be matched): the only visible sign is « Dernier webhook reçu » no longer moving.
- [ ] Stock change in ASODITECH → store stock updated (ASODITECH is the authority).

## 4. Shopify — development store (integration is behind `SHOPIFY_INTEGRATION_ENABLED`)

- [ ] Only with the flag on, on Preview/local: connect a dev store.
- [ ] Webhook from shop A never lands in tenant B (`X-Shopify-Shop-Domain` match).
- [ ] Order import + stock update.
- [ ] Known limit: order status is NOT pushed back to Shopify — the card's « Commandes » row says so.

## 5. WhatsApp

- [ ] Test mode: set `WHATSAPP_ALLOWED_RECIPIENTS` to the staff test number(s) on the
      environment under test (local / Preview — never Production). Any other number is
      refused before Meta is called (« Mode test WhatsApp » on the verification screen).
- [ ] Staff alert (Cloud API, central sender) to that **test number only** — received once.
- [ ] Without a configured sender, « Activer » is hidden and no alert is claimed as sent.
- [ ] Customer messages are manual `wa.me` links: open one with a test number,
      check `+212` / `0` normalisation. Nothing is sent automatically.
- Known limits: no message log, delivery status or retry (Meta's acceptance ≠ delivery).

## 6. Order / stock flow (test tenant)

- [ ] Create order → stock reserved; confirm → ship → deliver: stock movements match.
- [ ] Cancel before shipping → reservation released exactly once.
- [ ] Return: parcel reception → inspection → restock good units only.
- [ ] Store sale + sale return → stock and cash consistent.
- [ ] Aramex: label still opened from the carrier side (no stored label URL yet).
