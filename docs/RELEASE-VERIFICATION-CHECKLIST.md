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
      `20261011120000_return_receptions`, `20261012120000_user_preferences_payment_sync`
      (applied by `vercel-build` on push/deploy; the last one only adds 3 defaulted columns).
- [x] Local DEV database migrated too (`prisma migrate deploy` on the dev DB) before restarting
      `npm run dev` — the session user now reads `users.navFavorites`.
      OK 2026-10-12: dev DB `asoditech_ecommerce` 57/57 migrations applied.

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
- [ ] « Synchroniser » on the Commandes page with more than 15 new store orders → one click imports them all (toast shows the running total); a second click meanwhile → « Synchronisation déjà en cours ».
- [ ] An order with a plugin status (e.g. « shipped ») → the sync toast says « N commande(s) ignorée(s) : statut WooCommerce non pris en charge (…) ».
- [ ] « Importer l'historique des commandes » OFF on the WooCommerce card → a sync imports only orders placed after the switch; ON again → the history follows.
- [ ] Delete a product in the store → ARCHIVE here, its orders intact; a product sync keeps it archived; restore it from the store's trash → back to its store status (the `product.restored` webhook must be registered in WooCommerce).
- [ ] Delete one variation in the store → after « Synchroniser les produits » it is inactive here (not deleted).

## 4. Shopify — development store (integration is behind `SHOPIFY_INTEGRATION_ENABLED`)

- [ ] Only with the flag on, on Preview/local: connect a dev store.
- [ ] Webhook from shop A never lands in tenant B (`X-Shopify-Shop-Domain` match).
- [ ] Order import + stock update.
- [ ] Known limit: order status is NOT pushed back to Shopify — the card's « Commandes » row says so.
- [ ] Orders are fetched newest first (2026-10-12); a resume cursor saved before that change is ignored once (the next scan restarts from the newest orders).
- Known limit: a product archived here (or deleted in Shopify) is NOT un-archived by a Shopify sync (no « restored » webhook) — re-activate it by hand.

## 5. WhatsApp

- [ ] Test mode: set `WHATSAPP_ALLOWED_RECIPIENTS` to the staff test number(s) on the
      environment under test (local / Preview — never Production). Any other number is
      refused before Meta is called (« Mode test WhatsApp » on the verification screen).
- [ ] Staff alert (Cloud API, central sender) to that **test number only** — received once.
- [ ] Without a configured sender, « Activer » is hidden and no alert is claimed as sent.
- [ ] Paramètres → Notifications: click « WhatsApp » on « Rupture de stock » → muted (crossed out); trigger an out-of-stock → in-app alert arrives, no WhatsApp; click again → re-enabled.
- [ ] Break the store connection (wrong key) and click « Synchroniser » twice → ONE in-app alert and ONE WhatsApp (`asoditech_integration_down`) for the day.
- [ ] Customer messages are manual `wa.me` links: open one with a test number,
      check `+212` / `0` normalisation. Nothing is sent automatically.
- Known limits: no message log, delivery status or retry (Meta's acceptance ≠ delivery).

## 6. Order / stock flow (test tenant)

- [ ] Create order → stock reserved; confirm → ship → deliver: stock movements match.
- [ ] Cancel before shipping → reservation released exactly once.
- [ ] Return: parcel reception → inspection → restock good units only.
- [ ] Store sale + sale return → stock and cash consistent.
- [ ] Aramex: label still opened from the carrier side (no stored label URL yet).

## 7. Browser check — 2026-10-12 refinements (local dev or Preview, test tenant)

Prerequisite: the database used has all 57 migrations (dev DB: `prisma migrate deploy`
first — the session user reads `users.navFavorites`). Log in as OWNER unless noted.

| # | Route | Do | Expect |
|---|---|---|---|
| A1 | `/commandes/nouvelle` | Click « Client », press ↓ ↓ Enter; then type 2 letters; Escape | Recent customers list on open; arrow keys move, Enter selects, card with « Changer » / ✕; « Créer le client » panel still works |
| A2 | `/commandes/nouvelle` (tenant with ≥ 2 warehouses) | Look at the top | « Entrepôt de préparation » is step 1, above Client; changing it refreshes line stock; no second selector below |
| A3 | `/tracabilite?q=<SKU>` (finance user) | Open a product received via Réception, and one never received | Reception rows show their cost; other rows « non enregistré » (tooltip); « Coût d'achat actuel » card; no cost anywhere → « non renseigné » + link, never 0 |
| A4 | `/commandes/[id]` → manual shipment | Create with tracking `TEST-123`, then another order same carrier `test-123 ` | Second refused « déjà utilisé par la commande CMD-… »; another carrier accepted; after cancelling the first, reuse accepted |
| A5 | `/rapports/ventes`, `/analyses`, `/finance`, `/commandes`, `/depenses`, `/produits/exporter`, `/livraison`, `/confirmation/performance` | Pick custom Du/Au, then click a preset | Same control everywhere; Au cannot be before Du; after a preset the Du and Au inputs are empty (no stale custom dates; the preset defines the period); URL params unchanged |
| B1 | `/rapports/ventes?canal=…` (tenant with ≥ 2 online channels), `/rapports/canaux` export, `/tableau-de-bord?canal=magasin` | Switch channel, pick an empty one, export CSV | Figures change; empty channel = zeros; CSV matches screen; « Magasin » dashboard hides online-order sections with a note |
| B2 | `/parametres?section=commandes` | Toggle « Paiement confirmé par la boutique »; with it ON, mark a test WooCommerce order paid in the dev store | Default OFF; ON → order « Payé » after its webhook, history entry; a carrier « Livré » never changes payment |
| B3 | `/produits`, `/integrations`, `/tableau-de-bord` (finance user) | Leave a product without cost, then fill it | Amber banner, below the header (not covering it); link → `/produits?cout=manquant`; banner gone after filling; absent for a non-finance user |
| C1 | `/commandes/[id]` of an EXPEDIEE order | Set its shipment « Retourné » | Order → « Retour », one history entry + alert; stock unchanged until inspection; a « Échec » shipment leaves the order as is |
| C2 | `/livraison/retours` | Tick 2+ « À réceptionner » rows → « Réceptionner la sélection » | Confirmation dialog; per-parcel result; failed rows stay selected; « Prochaine étape » column; scanning only adds to the lot |
| D2 | `/commandes` « Synchroniser » (dev store, > 15 new orders) | Click once; click again during the run | Loops until done with a running count; second click « Synchronisation déjà en cours »; no duplicate orders; unsupported statuses reported |
| D2 | `/integrations` WooCommerce card | Turn « Importer l'historique des commandes » OFF, sync | Old orders skipped, new orders and webhooks still imported |
| D3 | Dev store | Delete a product; then restore it (WooCommerce trash → restore, `product.restored` webhook registered) | Deleted → « Archivé », orders intact; resync keeps it archived; restored → back to its status; removed variation → inactive |
| E1 | `/parametres/notifications` | Switch off the WhatsApp chip of « Synchronisation » | Saved per user; in-app alert still created; with `WHATSAPP_ALLOWED_RECIPIENTS` = a test number only, nothing sent to other numbers |
| E2 | Any page, sidebar | Hover an item → ★; pin 2, reorder with ↑/↓, reload, unpin; then remove the permission of a pinned page | « Favoris » section persists across reload/devices; the page without permission disappears from Favoris and opening its URL is still refused |

**Results — 2026-10-12, local dev DB, isolated copies (15 rows):** 6 PASS (A1 A2 A4 B1 C1 E2) ·
4 PASS WITH CAVEAT (A3 A5 B3 C2) · 5 BLOCKED (B2, D2 ×2, D3: need a real dev store; E1: needs a real
WhatsApp test number) · 0 NOT TESTED.
- A3: « non renseigné » + link seen on a product whose reception rows carry a cost but which has no
  current cost; a product with no cost anywhere was not opened on `/tracabilite`; the « non enregistré »
  tooltip was read from the accessibility text, not hovered; tested as OWNER only.
- A5: exercised on 7 of the 8 routes; `/confirmation/performance` checked in code only.
- B3: « banner gone after filling » not observed (other products still lack a cost); filling the demo
  product dropped the count 9 → 8.
- C2: success path only (2 parcels); the failed-parcel list and « failed rows stay selected » were not
  exercised in the browser (covered by automated tests).
