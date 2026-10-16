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
- [ ] Pending since 2026-10-15/16 — apply on **Preview, then Production** (not applied to either yet): `20261015120000_customer_barcode`,
      `20261015140000_product_barcode_generation`,
      `20261016120000_delivery_payment_brand_logo_whatsapp_outbox`,
      `20261016130000_whatsapp_outbox_runtime_grant` (explicit grant of the new table to
      `asoditech_app`). Before applying anywhere: confirm the target has
      `ALTER DEFAULT PRIVILEGES FOR ROLE <migration role> … TO asoditech_app` (pg_default_acl)
      and that the migration runs as that role; after: no public table without
      SELECT/INSERT/UPDATE/DELETE for the runtime role (tests/integration/runtime-role-privileges.test.ts).
      Local status (2026-10-16): local DEV DB `asoditech_ecommerce` has all four applied (after a
      `pg_dump` backup); local TEST DB has the first three (+ an equivalent manual grant),
      `20261016130000` still pending there.
- [ ] Preview: the four migrations above applied (`prisma migrate status` clean) and the
      pg_default_acl / runtime-role grant check done — result: ____
- [ ] Production: same four migrations applied and the same grant check done — result: ____
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
- [ ] Shopify card: « Que faire lorsqu'un produit est supprimé de la boutique ? » shows
      « Me demander avant de dissocier » by default.
- [ ] Mode « Me demander… »: delete a linked test product in the dev store → the product is
      flagged (notification + product page) and the link is kept until an authorised user confirms;
      a product imported from Shopify is archived here, its orders/stock intact.
- [ ] Mode « Dissocier automatiquement »: delete a product → unlinked only after Shopify confirms it
      no longer exists; set a product ARCHIVED or DRAFT in Shopify instead → never unlinked.
- [ ] « Retirer de la boutique » on a published product → Shopify status ARCHIVED (never deleted);
      « Remettre en vente » → ACTIVE.
- [ ] Same remote-deletion choice on the WooCommerce card (§3): a product imported from WooCommerce
      is archived on `product.deleted`; the link: manual flags; auto unlinks only on a confirmed
      deletion (a product only moved to the trash is flagged, not unlinked);
      « Retirer de la boutique » → WooCommerce `draft`, never a permanent delete.

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
- (Until 2026-10-16 there was no message log, delivery status or retry. Since then — local
  build, not deployed — staff alerts go through a durable outbox `whatsapp_outbox`; the checks below
  need migrations `20261016120000` + `20261016130000` applied.) Meta's acceptance ≠ delivery still holds.
- [ ] Intégrations (user with `integrations.manage`): card « Alertes WhatsApp — suivi » shows the
      pills « Numéro d'envoi configuré », « Canal activé pour l'entreprise », « Relances automatiques
      configurées » (or their « non » variants) and the « en attente d'envoi » / « en échec » counters.
- [ ] « Derniers envois »: a triggered test alert appears (recipient shown by name, never the number)
      with status « En attente » → « Envoyé ».
- [ ] Force a failure (e.g. a number outside `WHATSAPP_ALLOWED_RECIPIENTS` on a test env, or a bad
      token): retries with backoff, at most 5 attempts, then « Échec »; « Réessayer » appears on that row
      only, and only for `integrations.manage`; on a non-failed row the server refuses
      « Seul un envoi en échec peut être réessayé. »
- [ ] Cron `GET /api/cron/whatsapp-outbox`: without `CRON_SECRET` → 503; wrong/missing
      `Authorization: Bearer …` → 401; correct bearer → pending messages processed. NOTE: the route is
      NOT scheduled in `vercel.json` — schedule it (Vercel Cron or an external caller) and set
      `CRON_SECRET` on the environment, or automatic retries never run.
- [ ] `WHATSAPP_ENABLED_TEMPLATES`: the 4 V1 templates (`asoditech_stock_out`,
      `asoditech_delivery_failure_summary`, `asoditech_integration_down`,
      `asoditech_verification_code`) send without it; another template (e.g. `asoditech_new_order`)
      is recorded « Ignoré » with « Configuration : modèle « … » non approuvé/configuré … » until listed.
- [ ] « Catégories d'alertes »: switch a category off → toast « WhatsApp désactivé pour « … » », the
      next alert of that category is skipped (« Catégorie d'alerte désactivée par l'entreprise. »);
      in-app alert still created. Personal mute (« WhatsApp » pill on `/parametres/notifications`) →
      skipped with « Alerte coupée par le destinataire. »

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

## 8. Customer codes and carrier connectors — 2026-10-15 (docs/adr/0060)

Status: implemented locally and tested on the local test DB only; migration
`20261015120000_customer_barcode` NOT applied to Preview/Production yet.

- [ ] Apply the migration on Preview first (vercel-build runs `prisma migrate deploy`).
- [ ] /platform: « Codes clients » switch on a TEST tenant → audit entry.
- [ ] Paramètres → Commandes: « Code-barres client automatique » visible only once granted; turn on.
- [ ] Create a customer → « CL-000001 »; same name + phone again → same customer, same code.
- [ ] Customer page: Code 128 renders, « Copier », « Imprimer la carte » prints 85.6 × 54 mm.
- [ ] Scan the printed card with the HENEX scanner in: Clients search, order-form customer search, Ventes → Client (also with the camera button).
- [ ] Revoke the grant on /platform → no new codes; existing codes unchanged.
- [ ] Livraison → Configurer a NEW connector: Aramex is not offered; an existing Aramex connection still opens and saves.
- [ ] Ameex (2026-10-16, sandbox-verified only): selectable for a NEW connection with the « bac à sable uniquement » notice; « Configurer » shows the webhook URL to paste; then validate a real (live key) parcel per docs/carriers/ameex.md and review the provisional status mapping.
- [ ] Sendit (2026-10-16): selectable for a NEW connection with the « pas encore validé sur un compte réel » notice; then run the « Live validation checklist » in docs/carriers/sendit.md on a real account.

## 9. Product / variation barcode generation — 2026-10-15 (docs/adr/0061)

Status: implemented locally; migration `20261015140000_product_barcode_generation` NOT applied to Preview/Production yet.

- [ ] Paramètres → Stock (« En ligne + Magasin » test tenant): « Génération automatique des codes-barres » → on.
- [ ] New product: « Générer » next to Code-barres → 13 digits starting with 20; Enregistrer.
- [ ] Type a code first, then « Générer » → confirmation before replacing.
- [ ] Variable product → Variations → generator with « Générer un code-barres pour chaque nouvelle variation » → each variation has its own code (Identité tab).
- [ ] Identité tab: « Générer » on one variation fills only that variation's field; « Ajouter » saves it.
- [ ] Print a label → caption « CODE INTERNE — PAS UN EAN/GTIN »; scan it with the HENEX scanner in Ventes, Réceptions, Emballage and the search.
- [ ] Turn the setting off → « Générer » disappears; manual entry still saves.
- [ ] Catalog export (WooCommerce / Shopify CSV): generated codes are not in the GTIN / Barcodes column.

## 10. Payments and refunds — 2026-10-16 (local build, not deployed)

- [ ] `/parametres?section=commandes` (« Marquer automatiquement les commandes comme payées à la
      livraison »): OFF by default for every company; changing it needs `settings.manage`.
- [ ] OFF: deliver a test order (parcel « Livré ») → payment stays « En attente ».
- [ ] ON: an « En attente » order delivered (parcel « Livré », manual order status « Livrée », or a store
      update moving it to Livrée) → « Payé », with a history entry; a « Échec » payment never changes.
- [ ] ON: import an order that is ALREADY delivered → payment unchanged; orders delivered before the
      switch was turned on are not changed (not retroactive).
- [ ] WooCommerce dev store: a COD (`payment_method = cod`) order marked « completed » (WooCommerce stamps
      `date_paid`) → NOT treated as paid in ASODITECH (`wooReportsPaid`).
- [ ] Refund cap: on a test order, create a refund left « En attente », then a second one exceeding the
      remainder → refused « Le montant dépasse le solde remboursable (… restants). » (pending and approved
      refunds both count; a rejected one does not); fully refunded → « Cette commande a déjà été
      intégralement remboursée. »
- [ ] Missing-cost banner (finance user): with a product that has only a per-location cost, the banner
      adds « Dont N avec un coût par emplacement : utilisé pour les ventes magasin et les commandes créées
      ici depuis cet emplacement, pas pour les commandes importées des boutiques ni les rapports en ligne. »

## 11. Analytics / reports store scope — 2026-10-16 (local build)

- [ ] `/analyses/confirmation`, `/analyses/livraison`, `/analyses/commissions` (and `/analyses`) with a
      magasin or emplacement filter → the section is hidden and replaced by a « Non filtrable par … »
      notice with a « Retirer le filtre … » link; no global online figures shown under the filter.
- [ ] CSV export of the same blocked views (`/analyses/export/confirmation`, `livraison`,
      `commissions`, `revenus`) → meta lines, then a « Non filtrable » row with the reason; no figures.
- [ ] `/rapports/retours` with a magasin / canal filter → « (non filtrable par magasin — … ) » /
      « (non filtrable par canal en ligne) » shown.
- Note: the top-level `/livraison` and `/commissions` pages have NO such notice (checked in code
  2026-10-16) — only the `/analyses/*` views above.

## 12. Carrier webhooks and manual parcel guards — 2026-10-16 (local build)

- [ ] Ameex (sandbox key only): « Configurer » shows « URL du webhook à coller chez le transporteur »;
      paste it + the same secret in the Ameex sandbox account; a sandbox status change → the event is
      recorded `TRAITE` and the shipment re-fetched; same audit entry / failure alert / WooCommerce push
      as a manual « Synchroniser ». Unsigned or wrong-secret webhook → 401, nothing processed.
- [ ] Webhook lifecycle (automated in `tests/integration/delivery-webhook-route.test.ts`; on a real
      carrier only observe): failure → 500 and the same delivery is retried; concurrent duplicate → 503
      `Retry-After`; invalid local transition → acknowledged `TRAITE`, not retried; suspended company →
      signature checked, then accepted and ignored.
- [ ] Manual status on a parcel « En attente » → « Retourné » is not offered / refused (« Un colis encore
      « En attente » n'est jamais parti … »); on an order never shipped → refused (« Cette commande n'a
      jamais été expédiée … »).
- [ ] A creation « à vérifier » parcel: the select offers only « Échec » and « Annulé ».
- [ ] Parcel set « Retourné » / « Livré » when the order cannot follow → warning toast « Colis « … », mais
      la commande reste « … » : … » (10 s).
- [ ] `/livraison/retours`: scan a parcel whose order never shipped → added to the lot as « Non
      éligible » (« … non éligible : la commande n'a jamais été expédiée. »); « Réceptionner » refused by
      the server (« Cette commande n'a jamais été expédiée — aucune unité physique à recevoir. »).

## 13. Tenant brand logo — 2026-10-16 (local build; needs migration `20261016120000`)

- [ ] `/platform` « Logo du menu » switch on a TEST tenant → « Autorisé »; toast « Logo de l'entreprise
      autorisé dans le menu. »
- [ ] Tenant: `/parametres?section=entreprise` → « Logo » (« Importer une image » or https URL) saved.
- [ ] Sidebar / mobile drawer show the company logo (alt « Logo … »); collapsed rail → compact size;
      dark theme → the logo sits on a white chip; an SVG or broken URL → ASODITECH mark.
- [ ] Revoke the grant → toast « Logo retiré : le menu affiche de nouveau ASODITECH. » and the shell
      shows the ASODITECH mark again; the logo stays on printed reports / delivery invoices.
- [ ] Sidebar / mobile drawer no longer contain « Centre d'aide » or the Clair/Sombre switch: help =
      floating « Centre d'aide » button; theme = topbar button, also on a phone.

## 14. Article pickers — 2026-10-16 (local build)

- [ ] Réception (`/receptions/nouveau`) and Vente magasin (`/ventes/nouvelle`) share the same picker:
      click / Enter keeps the list and query open; a scan (scanner or camera) clears them; added items get
      ✓ and a removable chip, « Terminé » closes; each line names the exact variation; picking an item
      already on the document adds 1 (sale: capped by available stock).
- [ ] Transfert: search « Nom, SKU ou code-barres… », Enter / camera resolves an exact code, the picker
      stays open for several articles.
- [ ] Inventaire (`/inventaires/[id]`): « Rechercher ou scanner : nom, SKU ou code-barres… » → the
      matching line is focused.
- Note: transfer and stocktake use their own pickers (same exact-code resolver and « Scanner » button),
  not the shared reception/sale component.


## 15. Carrier outcome safety, host allowlists, UI polish — 2026-10-16 (local build, not deployed)

Validation status of each carrier connector (what has really been exercised):
- **Sendit** — official public spec + stubbed-fetch tests only; never run against a real account.
- **Ameex** — sandbox only (`test_` key, 2026-10-16); no live key used.
- **OzonExpress** — the earlier live test (ADR 0013); the 2026-10-16 changes (host allowlist, 408/409
  « à vérifier ») are covered by mocks only.
- **Aramex (legacy, existing connections only)** — unverified on a real account.
- **WhatsApp outbox** — mocks only; no real message sent.

Carriers (on a TEST tenant; no real customer parcel):
- [ ] Sendit, first real parcel: look at the raw `/login` and `POST /deliveries` answers — `success` is a
      JSON boolean (if it is the string `"true"`, the connection test fails as « Réponse Sendit
      illisible » and every creation is « à vérifier »: fix the schema first). docs/carriers/sendit.md
      « Still open » 12.
- [ ] Sendit « Étiquette » opens a link on `https://app.sendit.ma/…`; a label on any other host is
      dropped (no link offered).
- [ ] A creation answered 408 / 409 / any unexpected status (or Sendit `success: false` in a 2xx) leaves
      the parcel « À vérifier » (never « Échec ») — automated in `tests/lib/delivery-create-outcome.test.ts`
      and the per-carrier client tests; on a real carrier only observe if it happens.
- [ ] A creation « à vérifier » settled by hand as « Échec » or « Annulé » books **no** failure / return
      cost (shipment cost stays empty, not counted in the delivery report). ADR 0032 addendum.
- [ ] OzonExpress « Configurer »: a base URL other than `https://api.ozonexpress.ma`, or a portal URL
      other than `https://client.ozoneexpress.ma`, is refused with the « hôte officiel » / « doit être sur
      client.ozoneexpress.ma » message.
- [ ] Existing Aramex connection with an old non-Aramex URL override → clear configuration error (not a
      silent send); with no override or a `ws.aramex.net` / `ws.dev.aramex.net` one → works as before.
- [ ] Production build: the test-only mock hosts are refused (`NODE_ENV` is not `test`).

WhatsApp:
- [ ] Integrations / notification switches show « Inactive — … » with the reason when the channel, the
      sender or the template is unavailable, and « Activée » otherwise.
- [ ] Outbox (mocks): a message claimed by one worker and re-claimed after expiry is finished only once
      (stale `finish()` ignored, incl. the ABA case after « Réessayer ») — DB test in
      `tests/lib/whatsapp-outbox.test.ts` (header: written, run only by the coordinator on the test DB).

UI (desktop + a phone, light and dark):
- [ ] Every wide table: edge fade appears only when it overflows; the scroll region is reachable with Tab
      and scrolls with the arrow keys.
- [ ] `/commandes`, `/livraison`, `/livraison/retours`: lower-priority columns hide on narrow screens, no
      horizontal page scroll; `/platform` tables still scroll horizontally with the hint.
- [ ] « Centre d'aide » button clears the iPhone home bar and is hidden while a settings form has unsaved
      changes (reappears after save / cancel). Note: without `viewportFit: "cover"` the safe-area insets are
      0 — see docs/OWNER-DECISIONS-2026-10-16.md.
- [ ] Order page on a phone: the lifecycle stepper is vertical.
- [ ] SegmentedControl tabs, Paramètres nav and Configuration nav scroll horizontally on a phone without
      cutting labels; selects / pickers keep a usable width.
- [ ] `npm run dev`: no Next.js dev indicator badge (dev only, `devIndicators: false`).
- [ ] Livraison → Prestataires → « Configurer »: « Annuler » closes without saving; for a connector with
      webhooks, « URL du webhook à coller chez le transporteur » + « Copier » → « Copié ».
- [ ] `/parametres/notifications`: subtitle « Vos notifications personnelles et la sécurité de votre
      compte. »
- [ ] Order page, COD order: « Non encaissé — commande retournée » (RETOUR), « Non encaissé — livraison
      en échec » (ECHEC), « Rien à encaisser — commande annulée / remboursée » instead of an amount; a
      normal order still shows the amount.
- [ ] Variable product: a variation without its own price shows the parent price in the price range.
- [ ] ⌘K / Ctrl+K: a partial order number, a partial phone number and a customer-code prefix (`CL-00…`)
      find the order / customer; results update after typing pauses (~250 ms), no request per keystroke.
- [ ] `/commandes` search: results update while typing (~300 ms) with « N résultat(s) pour « … » » /
      « Aucun résultat pour « … » ce mois-ci — essayez « Toute la période ». ».
- [ ] WooCommerce store settings → deletion mode: the note says an imported product is also archived.
- Hydration warning seen in dev on `/rapports/canaux` (`caret-color: transparent` injected by a browser
  extension / automation): not reproduced without it; no code change.
