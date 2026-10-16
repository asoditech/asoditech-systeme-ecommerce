# ADR 0060 — Automatic customer codes, Ameex/Sendit carriers, Aramex retirement

(Title until 2026-10-16: « … Ameex/Sendit scaffolds … ». Both connectors were
completed and registered on 2026-10-16 — see the two addenda and « Current
status (2026-10-16) » below.)

Status: Accepted — implemented locally 2026-10-15/16 (not committed, not deployed).

## Context
Two requirements were missing (audit 2026-10-15): automatic customer barcodes,
and the intended carriers Ameex and Sendit (Aramex had been selected by
mistake). Owner decisions of 2026-10-15 apply.

## Decisions

### Customer codes « CL-000001 »
- Format `CL-` + tenant counter padded to 6 digits, growing past 999 999
  (`CL-1000000`); rendered as Code 128.
- Two switches, both required: the **platform grant**
  `Tenant.customerBarcodesGranted` (written only by
  `setTenantCustomerBarcodeGrantAction`, platform admins, audited
  `tenant.customer_barcode_grant_changed`) and the **tenant switch**
  `BusinessSettings.customerBarcodeEnabled` (`updateCustomerBarcodeSettingAction`,
  `settings.manage`, re-checks the grant on the server, audited `settings.updated`).
  Revoking the grant also switches the tenant setting off; existing codes are kept.
- Generated only in `findOrCreateCustomer`'s create branches (every creation
  path), in the same transaction as the insert; the counter
  `Tenant.nextCustomerBarcodeNumber` is claimed by an atomic increment (the
  tenant row lock serialises concurrent creations). Numbers already used by a
  product SKU, variation SKU or product barcode (any case) or by a restored
  customer code are skipped; a unique clash retries the whole insert (max 3).
  The counter is never reset (off → on continues the sequence).
- Never on reuse (same name + phone, store re-imports), never from caller input,
  never on edit. **No backfill** of existing customers.
- Uniqueness: `@@unique([tenantId, barcode])`; NULLs are distinct, so customers
  without a code are unlimited. Two tenants may both hold `CL-000001`.
- (Superseded 2026-10-15 by docs/adr/0061: the « `CL-` + digits » reservation
  of product SKUs / barcodes was removed — it rested on a misread requirement
  and is not needed: product lookups never resolve customer codes, and the
  customer generator already skips any number used by a product identifier.)
- UI: « Code client » column (when granted or any code exists), customer page
  card (Code 128 + copy), printable card `/clients/[id]/carte` (85.6 × 54 mm),
  exact-code lookup in the customer list, global search, order-form customer
  search and the in-store sale picker (typed, keyboard scanner, camera).
  Product scan flows never resolve customer codes.
- Keyboard-layout mismatch (QWERTY scanner on AZERTY and the reverse) is
  corrected for customer codes and reported (« disposition de clavier »).
- Backup/restore: codes restore as is; the counter is moved past the highest
  restored code (`advanceCustomerBarcodeCounterPastExisting`).

### Carriers
> The Ameex and Sendit bullets below describe the state **on 2026-10-15**.
> Both were superseded on 2026-10-16 (registered connectors) — see the
> addenda and « Current status (2026-10-16) » at the end.

- **Ameex** (until 2026-10-16): scaffold only (`providers/ameex/`, `SCAFFOLD_NOT_LIVE_TESTED`):
  header auth, fixed base URL, https + SSRF guard, timeout, 60/min limiter,
  one-shot POST semantics, connection test, webhook HMAC (`t.rawBody`, ±300 s,
  our policy), sandbox-event filter. **Not registered.** Blocked on four
  owner-provided sandbox responses (status catalogue, cities, one creation,
  its tracking). See docs/carriers/ameex.md.
- **Sendit** (until 2026-10-16): pure modules only (`providers/sendit/`,
  `PURE_MODULES_ONLY_CLIENT_BLOCKED`): schemas, create body, parsers, error
  mapping, **provisional** status mapping (`PROVISIONAL_PENDING_OWNER_REVIEW`).
  No client, **not registered**; base URL and token scheme are undocumented.
  See docs/carriers/sendit.md.
- **Aramex**: `acceptsNewConnections: false`. Hidden from the connector choice
  and refused server-side for a connection not already using it; existing
  Aramex connections keep working. Nothing deleted or unregistered.
- **Generic webhook route** `/api/webhooks/delivery/[providerId]`: one URL per
  connection, raw body (1 MiB cap), adapter's own signature scheme, same 401
  for unknown connection and failed verification, suspended tenants ignored,
  optional adapter hook `shouldIgnoreWebhookEvent`, then the existing
  `handleDeliveryWebhook` (replay record + authoritative re-fetch).
- **FETCH_LABEL** capability + `fetchLabel` + « Étiquette » button: the signed
  https link is fetched on demand and never stored. No real carrier declared
  it until 2026-10-16; Sendit now declares it (see addendum).

## Release status (2026-10-15)

> Historical snapshot of 2026-10-15. The Ameex, Sendit and « Webhook route /
> label capability » rows are superseded by « Current status (2026-10-16) »
> at the end of this ADR.

| Item | Status |
|---|---|
| Customer codes | Implemented and unit/DB-tested on the local test DB; not deployed |
| Migration `20261015120000_customer_barcode` | Created; applied ONLY to the local disposable test DB (`asoditech_ecommerce_test`); not applied to the local dev DB, Preview or Production |
| Ameex | Scaffold implemented and unit-tested; not tested against the real API; blocked on sandbox response bodies; not safe for live activation; not registered |
| Sendit | Pure modules unit-tested; client blocked on contract confirmation; status mapping provisional; not registered |
| Aramex retirement | Implemented and tested; existing connections preserved |
| Webhook route / label capability | Implemented and tested with the reference fixture; no real carrier uses them yet |

## Addendum (2026-10-16) — Sendit connector implemented from the official spec

The official public spec (https://app.sendit.ma/docs/api-docs.json) settles the
two blockers above: base URL `https://app.sendit.ma/api/v1/` and
`Authorization: Bearer <JWT>` from `POST /login`. Sendit now has a client and a
`DeliveryProviderAdapter` (`SENDIT_VERIFICATION =
IMPLEMENTED_FROM_OFFICIAL_SPEC_NOT_LIVE_TESTED`) and is **registered**:
selectable for new API connections, with the visible notice « Connecteur Sendit
disponible mais pas encore validé sur un compte réel » (new optional adapter
field `notice`, shown in « Configurer ») and a « Guide : Sendit » in Livraison →
Documentation.

- Capabilities: CREATE_SHIPMENT, FETCH_STATUS, FETCH_TRACKING, FETCH_COST,
  FETCH_CITIES, FETCH_LABEL (Sendit is the first real carrier to declare
  FETCH_LABEL). No CANCEL_SHIPMENT (DELETE semantics undocumented), no
  WEBHOOKS (none documented).
- Creation follows the ADR 0013 addendum: one attempt; an uncertain outcome
  → `DeliveryOutcomeUnknownError` (« à vérifier »), never a second create.
- JWT cached in memory per credential pair (SHA-256 key), 20 min, one
  re-login on 401 for reads.
- Prepaid orders are refused before sending (amount semantics undocumented).
- Status mapping still PROVISIONAL_PENDING_OWNER_REVIEW; raw status kept.
- Verified only by stubbed-fetch unit tests; no live call has been made.
  Remaining questions: docs/carriers/sendit.md « Still open ».

## Addendum (2026-10-16) — Ameex connector completed from sandbox evidence

The owner authorized sandbox calls (`test_` key, fictitious `SBX-` parcel). The
responses, with credentials removed, are in
`tests/fixtures/ameex/sandbox-responses-2026-10-16.json`, and they resolve the
four blockers listed above. Ameex is now **registered**
(`AMEEX_VERIFICATION = SANDBOX_VERIFIED_2026_10_16`). It is selectable for new
API connections and shows the notice « validé sur le bac à sable Ameex
uniquement ». Livraison → Documentation has a « Guide : Ameex ».

- Capabilities: CREATE_SHIPMENT, FETCH_STATUS, FETCH_TRACKING, FETCH_CITIES,
  WEBHOOKS. Still blocked because Ameex does not document them: CANCEL_SHIPMENT,
  FETCH_LABEL, GENERATE_MANIFEST and FETCH_COST. MassTracking/MassInfo were
  observed but are not wired, because the adapter contract has no bulk hook.
- Add is **form-encoded**: a JSON body is refused. Business errors come back as
  HTTP 200 with `api.type: "error"` and become a definite DeliveryConfigError
  with a fixed French message; Ameex's free-text `msg` is never echoed. If
  `login` ≠ success, the result is DeliveryAuthError.
- Creation follows the ADR 0013 addendum: one attempt only. An uncertain
  outcome (including a success that has no `data.code`) becomes
  DeliveryOutcomeUnknownError.
- Status = the latest tracking event by `sorting_time` (Unix seconds). The raw
  status is `statut[/statut_s]` and is always kept.
- Status mapping is PROVISIONAL_PENDING_OWNER_REVIEW. Refusal-type codes map to
  ECHEC, which is legal because ECHEC → RETOURNE / EN_TRANSIT / LIVRE remain
  allowed. REFUNDED and unknown codes map to null.
- A verified webhook now ends in a real `fetchStatus` re-fetch. In the
  scaffold, FETCH_STATUS was missing and the sync ended in an error.
- Not verified: a production key, a real signed webhook, prepaid `cod=0`, phone
  formats, and the bad-key response. See docs/carriers/ameex.md « Open points ».
  (Until later on 2026-10-16 the webhook URL / connection id was not shown in
  the UI; it now is — see below.)

## Addendum (2026-10-16) — webhook URL shown, webhook lifecycle, Aramex creation

- **Webhook URL in the UI.** The « Configurer » dialog
  (`src/components/delivery/provider-connection.tsx`) shows a read-only field
  « URL du webhook à coller chez le transporteur » =
  `<origin>/api/webhooks/delivery/<connection id>` for every connector that
  declares `WEBHOOKS` (today: Ameex only), with a reminder to enter the same
  webhook secret on both sides.
- **Webhook event lifecycle** (`ShipmentWebhookEvent`): `EN_COURS` (claimed by
  one request) → `TRAITE` / `IGNORE` / `ECHEC`. A processing failure answers
  500 so the carrier retries the same delivery (an `ECHEC` row, or a stale
  `EN_COURS` claim, can be re-claimed); a concurrent duplicate answers 503 with
  `Retry-After`. An event whose status is an invalid local transition is
  acknowledged (`TRAITE`), not retried. A suspended company's events are
  signature-verified first, then accepted and ignored. Webhook-driven updates
  now write the same audit entry, failure alert and WooCommerce status push as
  a manual sync.
- **Aramex creation** (existing connections only): one attempt, no automatic
  resend; an uncertain outcome or `ERR30` → « à vérifier ».

## Current status (2026-10-16)
| Item | Status |
|---|---|
| Ameex | Registered, selectable for new connections. Capabilities CREATE_SHIPMENT, FETCH_STATUS, FETCH_TRACKING, FETCH_CITIES, WEBHOOKS (no cancel / labels / manifest / prices). Validated on the Ameex **sandbox** only (one fictitious SBX parcel, 2026-10-16); production key and a real signed webhook not tested. Status mapping provisional. |
| Sendit | Registered, selectable for new connections. Implemented from the official public spec; **not live-tested** (stubbed-fetch unit tests only). Capabilities CREATE_SHIPMENT, FETCH_STATUS, FETCH_TRACKING, FETCH_COST, FETCH_CITIES, FETCH_LABEL; no webhooks, no cancel. Status mapping provisional. |
| OzonExpress | Unchanged (live-tested earlier). |
| Aramex | Retired for new connections (`acceptsNewConnections: false`), hidden from the connector list unless the company already has an Aramex connection; existing connections keep working. |
| Generic webhook route | Used by Ameex (the only connector declaring WEBHOOKS); URL shown in « Configurer ». No real signed carrier webhook received yet. |
| FETCH_LABEL | Declared by Sendit (first real carrier); not exercised against a live Sendit account. |
| Migrations | `20261015120000_customer_barcode`, `20261015140000_product_barcode_generation`, `20261016120000_delivery_payment_brand_logo_whatsapp_outbox`, `20261016130000_whatsapp_outbox_runtime_grant`: all four applied on the local dev DB (2026-10-16, after a `pg_dump` backup); the first three on the local test DB (+ an equivalent manual grant), `20261016130000` pending there; **none applied to Preview or Production**. |
| Commit / deploy | Not committed, not deployed. |
