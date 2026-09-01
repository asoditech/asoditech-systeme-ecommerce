# ADR 0013 — OzonExpress delivery adapter (Phase 23)

## Status
Accepted (2026-08-31). **Amended 2026-09-01** — see the "Phase 23
continuation" addendum at the end: the owner has provided API documentation
confirming the endpoints, the adapter is now registered in production for
configuration + connection testing (still not auto-CONNECTE), and a
`GET /cities` authoritative catalogue + a safe verification path were added.
Where the addendum and the original body disagree, the addendum wins.

## Context
`docs/adr/0012-delivery-provider-integration.md` (Phase 22) built the
provider-agnostic delivery architecture — `DeliveryProviderAdapter`,
registry, capability model, credential lifecycle, shipment state machine,
webhook plumbing — and deferred "a real carrier adapter" as an
owner decision, not a technical gap. Phase 23's brief names the first
carrier to implement: **OzonExpress** (`ozonexpress.ma`), a Moroccan
last-mile / COD delivery company.

The system must eventually support **many** Moroccan carriers (Client A →
OzonExpress, Client B → carrier X, Client D → OzonExpress + carrier Y).
OzonExpress must therefore be implemented strictly as one adapter behind
the existing abstraction, with nothing OzonExpress-specific leaking into
the generic delivery service, DB orchestration, shipment UI, finance
layer, or order engine.

## API research

The phase brief required the real OzonExpress merchant API to be
researched before any code, and explicitly forbade inventing a contract.

**Finding: OzonExpress publishes no official, publicly accessible merchant
API documentation.** No developer portal, no OpenAPI/Swagger, no published
PDF. `contact@ozonexpress.ma` is the only documented integration channel,
and OzonExpress's own site lists "direct API integration with online
stores" as a service still *under study*.

An API demonstrably exists and is used in production by multiple
third-party platforms. Its shape was reconstructed on 2026-08-31 by
cross-referencing **four independent** integrations (a Laravel affiliate
SaaS, a Spring/Java order-management SaaS, a Python e-commerce automation
tool, and a standalone reverse-engineered `OZONE_EXPRESS_API.md`). Where
all four agree, confidence is reasonable; several important details they
*disagree* on are called out as UNKNOWN below.

### Contract as reconstructed (⚠️ community-corroborated, NOT confirmed)

| Aspect | Finding |
| --- | --- |
| Official merchant API | **Not documented publicly.** Access is arranged by contacting OzonExpress directly. |
| Base URL | `https://api.ozonexpress.ma` |
| Authentication | Customer id **and** API key as URL **path segments**: `/customers/{CUSTOMER_ID}/{API_KEY}/<action>`. No header/OAuth. The whole request URL is therefore secret. |
| Transport | `POST`, `multipart/form-data` request bodies (bulk tracking also accepts a JSON body). |
| Create shipment | `add-parcel` — fields `parcel-receiver`, `parcel-phone`, `parcel-city` (**numeric city id**), `parcel-address`, `parcel-price` (integer MAD, the COD amount to collect), `parcel-note`, `parcel-nature`, `parcel-stock` (`0` = ramassage/pickup, `1` = from OZ warehouse stock), optional `parcel-open`/`parcel-fragile`/`parcel-replace`, optional `products` JSON. A custom `tracking-number` may be supplied; OZ otherwise generates one. |
| Create response | Tracking number under a **flat** `TRACKING-NUMBER` **or** nested `ADD-PARCEL.NEW-PARCEL.TRACKING-NUMBER`. Also `DELIVERED-PRICE` / `RETURNED-PRICE` / `REFUSED-PRICE` (carrier fees, conditional on outcome). |
| Retrieve status | `tracking` (single: form `tracking-number`; bulk: JSON `{"tracking-number":[...]}`) and `parcel-info` (form `tracking-number`). |
| Cancellation | **No cancellation endpoint is known to exist** in any of the four integrations. |
| Webhooks / callbacks | **No webhook or callback mechanism is documented or used anywhere.** Status is poll-only. |
| Delivery cost | `DELIVERED-PRICE` — the fee that applies *if the parcel is delivered*. No separate cost call. |
| Errors | Frequently returned as **HTTP 200** with body `{"RESULT":"ERROR","MESSAGE":"..."}`, sometimes nested one level under the action key. Non-2xx statuses also occur. |
| City identifiers | Numeric ids, required by `add-parcel`. **No public authoritative city catalogue.** A `cities` endpoint may exist (one integration references it) but is unconfirmed. |
| Rate limits | **Undocumented.** |
| Sandbox / test env | **None known.** |
| Raw status vocabulary | **Genuinely unknown.** Every integration treats the tracking status as an opaque lower-cased string and maps defensively. |

### Decision on how to proceed

The brief's explicit instruction for "official documentation unavailable"
is to *implement only the adapter boundary and clearly mark the provider
`NOT_VERIFIED` until official credentials/documentation are supplied*,
and `docs/adr/0004` / `docs/adr/0012` already establish that shipping an
integration built on a guessed contract is worse than not shipping it.

Phase 23 therefore:

1. **Implements the full OzonExpress adapter** against the reconstructed
   contract — `client.ts`, `types.ts`, `mapper.ts`, `errors.ts`,
   `adapter.ts` under
   `src/lib/integrations/delivery/providers/ozonexpress/`, mirroring the
   WooCommerce/Shopify file layout. Every endpoint, field, and status
   string carries an `⚠️ UNVERIFIED` annotation pointing here.
2. **Fixture-tests the whole lifecycle** end-to-end against the real test
   database with mocked HTTP (`tests/helpers/fake-ozonexpress.ts`).
3. **Does NOT register the adapter in production.**
   `src/lib/integrations/delivery/providers/index.ts` stays empty. The
   adapter exports `OZONEXPRESS_VERIFICATION = "UNVERIFIED"` and a
   `registerOzonExpressProvider()` helper; enabling it is a **two-line
   change** in that file, to be made only once OzonExpress confirms the
   contract or supplies real docs. No schema, Server Action, or UI change
   is needed at that point.
4. Surfaces this as the **owner decision**: obtain an OzonExpress merchant
   account + written API details, verify the reconstructed contract
   (especially the status vocabulary, the city catalogue, and the COD /
   `DELIVERED-PRICE` semantics) against a real sandbox or a low-value live
   parcel, then flip the registration on.

`webhook.ts` was **not** created — the brief scopes it to "only if Ozon
officially supports webhooks/callbacks", and nothing indicates it does.

## Decision

### Adapter boundary
`ozonExpressAdapter` (`adapter.ts`) implements `DeliveryProviderAdapter`:

- **key** `"ozonexpress"`, **displayName** `"OzonExpress (Maroc) — contrat
  non vérifié"` (the "non vérifié" is deliberate and user-visible).
- **capabilities**: `CREATE_SHIPMENT`, `FETCH_STATUS`, `FETCH_COST`.
  - `CANCEL_SHIPMENT` is **not** declared — no cancellation endpoint
    exists. `cancelShipmentViaProvider` → `assertCapability` →
    `DeliveryUnsupportedCapabilityError` (typed "not supported"), never a
    local-only cancel that the carrier doesn't know about.
  - `WEBHOOKS` is **not** declared — poll-only via the existing
    `syncShipmentStatus` / "Synchroniser" button.
- **credentialFields** (new optional part of the adapter contract — see
  "UI" below): `customerId` (text), `apiKey` (password). These are the two
  values every observed integration uses; no `API Secret` or other
  invented field is added.
- **testConnection**: OzonExpress has no ping/account endpoint, so this
  does a `tracking` lookup for a sentinel code. Valid credentials return a
  parseable body (a "parcel not found" is treated as success — auth
  worked); bad credentials raise `DeliveryAuthError`, which propagates so
  the service records `ERREUR` + `lastError`.

### `client.ts` — one place for transport concerns
- Path-based auth means the **request URL is a secret**. The client never
  puts a URL, or anything derived from one, into a thrown error, a return
  value, or a log — callers only ever see the shared typed
  `DeliveryProviderError` subclasses with fixed French strings. Credential
  path segments are `encodeURIComponent`-escaped.
- SSRF: `assertPublicHost` (the shared
  `src/lib/integrations/shared/private-ip.ts`, same as WooCommerce/Shopify)
  is re-run immediately before **every** request, not just at
  construction — DNS rebinding defence. HTTPS is required.
- Timeout (20 s default, per-request override via config), retry with
  backoff on 429 / 5xx / network error (max 3 attempts), `redirect:
  "error"`.
- `assertNoApiError` unwraps the "HTTP 200 that is actually an error"
  case (flat or nested `{"RESULT":"ERROR"}`) and classifies the `MESSAGE`
  **without interpolating it** — `errorForApiMessage` only pattern-matches
  known substrings (`city`, `api key`, `not found`, …) to a typed error;
  anything else becomes a generic `DeliveryUnavailableError`.
- `parseMoney` never coerces a missing / empty / non-numeric value to `0`
  (docs/adr/0012, "Delivery cost").

### `mapper.ts` — all OzonExpress vocabulary lives here
- **City id resolution**: `resolveCityId` looks the recipient city up in
  the operator-supplied `config.cityIdByName` map and throws a typed
  `DeliveryConfigError` **before any network call** if it is missing —
  never guesses a numeric id.
- **Phone normalization**: `+212…` / `00212…` / `6…` → `0…` (10-digit
  local). An unrecognized shape is passed through as digits for the
  carrier to reject rather than silently mangled.
- **`buildAddParcelForm`**: assembles the documented multipart fields.
  COD `0` (prepaid order) is sent as `parcel-price=0` and is *not* treated
  as "missing cost"; a negative COD is rejected up front.
- **Response parsing** tolerates both the flat and the
  `ADD-PARCEL.NEW-PARCEL` envelopes and both the top-level and
  history-nested tracking-status shapes. A response with **no tracking
  number** or **no readable status** raises
  `DeliveryMalformedResponseError` — never a fabricated id or a guessed
  status.
- **`mapOzonExpressStatus`**: a deliberately small, conservative table of
  the French/English status strings that appear consistently across the
  reconstructed integrations, matched after accent/format normalization.
  **Anything not explicitly in the table returns `null`** and is preserved
  verbatim as `Shipment.providerStatusRaw` and reported as `unknown_status`
  by the shared `syncShipmentStatus` — the exact behaviour docs/adr/0012
  mandates.

### Status → local `ShipmentStatus` mapping (as implemented)

| OzonExpress raw (normalized) | Local |
| --- | --- |
| `nouveau colis`, `nouveau`, `new`, `en attente`, `pending`, `colis recu`, `receptionne`, `received`, `au depot`, `at warehouse`, `pris en charge`, `picked up`, `ramasse` | `EN_ATTENTE` |
| `expedie`, `shipped`, `en transit`, `in transit`, `en cours de livraison`, `out for delivery`, `mise en distribution`, `distribution` | `EN_TRANSIT` |
| `livre`, `delivered`, `livraison confirmee` | `LIVRE` |
| `non livre`, `echec de livraison`, `delivery failed`, `refuse`, `refused`, `refus client` | `ECHEC` |
| `retourne`, `returned`, `retour`, `retour a expediteur`, `return to sender` | `RETOURNE` |
| `annule`, `cancelled`, `canceled` | `ANNULE` |
| anything else | *unmapped* — raw string preserved, no local transition |

⚠️ This table is a best-effort reconstruction, **not** an OzonExpress
contract. It must be validated against real tracking responses before the
adapter is enabled.

### Credentials & multi-client isolation
Per `docs/adr/0002-domain-model.md`, this system is **one deployment per
client** — no `tenantId` column; isolation is at the database/deployment
level, orchestrated by the Control Center. The phase brief's "Client →
Instance → Delivery Provider Connection → encrypted credentials" chain
maps onto that exactly:

- **Instance** = the deployment (its own DB, env, domain).
- **Delivery Provider Connection** = a `ShippingProvider` row with
  `type = API`, `providerKey = "ozonexpress"`.
- **Encrypted credentials** = `ShippingProvider.credentialsEncrypted`,
  AES-256-GCM via `src/lib/crypto.ts` (same key/mechanism as
  `Integration.credentialsEncrypted`), holding
  `{"customerId": "...", "apiKey": "..."}`. Decrypted only inside
  `service.ts:loadApiProvider`, on the server, per operation.

Isolation guarantees, all pre-existing and unchanged by Phase 23:

- **Between instances**: separate databases. No shared global OzonExpress
  credential exists anywhere — none in env, code, or a shared table. The
  adapter has no module-level credential state; every call takes its
  credentials as arguments.
- **Between provider rows in one instance**: every shipment operation
  resolves its adapter + credentials from the **shipment's own
  `providerId`** (`loadApiProvider(shipment.providerId)`), never a
  caller-supplied provider. Config (`cityIdByName`, `stockMode`, …) lives
  on the same row. Two `ShippingProvider` rows → two independent encrypted
  credential blobs, two independent configs.
- Credentials are **never** returned to the browser (actions return
  `{ id }` only), **never** logged, **never** in a URL that reaches a log
  (the client keeps URLs internal), **never** in `AuditEvent` metadata,
  errors, or `lastError`.

### Shipment creation flow (unchanged generic pipeline)
`createShipmentViaProviderAction` → `service.ts:createShipmentViaProvider`:
validate order is shippable + address complete → create local `Shipment`
`EN_ATTENTE` (no `externalId`) → call `adapter.createShipment` → on
success persist **exactly** what OzonExpress returned (`externalId` =
tracking number, `trackingNumber`, `cost` = `DELIVERED-PRICE` or `null`,
`providerStatusRaw`); on any failure mark the same row `ECHEC` with a safe
message. `trackingUrl` is always `null` — OzonExpress documents no
deterministic per-parcel tracking URL, and docs/adr/0012 forbids guessing
one.

**Idempotency**: the local `Shipment.id` is sent as OzonExpress's custom
`tracking-number`; OzonExpress rejects a duplicate custom tracking number,
so a retried create surfaces as a typed error rather than a second real
parcel. This is in addition to the existing `(orderId, providerId)`
active-shipment pre-check and the `@@unique([providerId, externalId])`
constraint.

### Delivery cost
Only ever OzonExpress's own `DELIVERED-PRICE`, stored on the existing
`Shipment.cost` (same column MANUEL shipments use — `getFinanceSummary`
needs no change). ⚠️ Caveat: `DELIVERED-PRICE` is the fee *if delivered*;
a returned or refused parcel is billed `RETURNED-PRICE` / `REFUSED-PRICE`
instead. Phase 23 stores the delivered-case figure and does not attempt to
reconcile the final invoiced amount — that needs verified semantics.

### UI — Livraison → Prestataires
- New optional `credentialFields` on `DeliveryProviderAdapter`. When a
  selected connector declares them, `ProviderConnectionControls` renders
  proper typed inputs (label, `type="password"` masking, help text) and
  assembles the credentials JSON **client-side**; connectors without them
  keep the raw-JSON editor. Either way the credential object is POSTed once
  to `configureDeliveryProviderApiAction`, encrypted at rest, and never
  sent back.
- Saving credentials lands on `CONFIGURE` ("Configuré (non vérifié)"),
  never `CONNECTE`. Only a successful `testDeliveryProviderConnectionAction`
  sets `CONNECTE`; a failure sets `ERREUR` + `lastError`. Statuses reuse
  `INTEGRATION_STATUS_LABELS` verbatim (Non configuré / Configuré (non
  vérifié) / Connecté / Erreur de connexion).
- OzonExpress does not appear in the picker in production because it is
  not registered — the "Configurer" control stays disabled with the
  honest "aucun connecteur disponible" message, exactly as Phase 22 left
  it. The typed-field UI is exercised by the test suite via a
  test-registered adapter.

### RBAC & audit
No new permissions — `delivery.manage` already gates provider
configuration and every shipment mutation, enforced server-side in each
action. No new `AuditAction` values needed: the existing
`shipping_provider.api_configured` / `.connection_test_succeeded` /
`_failed`, `shipment.created` / `.creation_failed` / `.status_changed` /
`.status_sync_failed` / `.cancellation_failed` cover it. No credential,
key, or URL appears in any audit metadata.

## Test matrix
Fixture-based, real Prisma/Postgres test DB, mocked HTTP
(`tests/helpers/fake-ozonexpress.ts` — encodes the same reconstructed
contract, including the flat/nested envelopes and the HTTP-200-error
quirk):

- `tests/lib/ozonexpress-mapper.test.ts` — city resolution (incl. the
  "unmapped → typed error, never guessed" case), phone normalization,
  `buildAddParcelForm` (COD 0 vs missing, negative COD rejected, stock
  mode), flat + nested response parsing, "no tracking number → throw",
  "no status → malformed not unknown", the full status table + the
  "unknown → null" guarantee. (~30 assertions)
- `tests/lib/ozonexpress-client.test.ts` — `parseMoney` never-zero,
  path-auth placement, **api key never in a thrown error**, credential
  path-segment encoding, SSRF (private IP + non-HTTPS), 401/403/404/429/5xx
  mapping, non-JSON → malformed, timeout, HTTP-200 `RESULT:ERROR`
  unwrapping (top-level + nested + unclassifiable → generic French
  string), bad-credentials → `DeliveryAuthError`. (~25)
- `tests/lib/ozonexpress-adapter.test.ts` — verification marker, declared
  capabilities (+ `CANCEL_SHIPMENT` / `WEBHOOKS` rejected), typed
  credential fields, `testConnection` success / auth failure / incomplete
  creds (no network call), `createShipment` (exact passthrough, nested
  envelope, unmapped city with zero network calls, "City Not Found" →
  config error, omitted tracking number → malformed, idempotent retry),
  `fetchStatus` + `mapStatus` (known + unknown). (~18)
- `tests/actions/ozonexpress-provider.test.ts` — Server Action layer:
  CONFIGURE-not-CONNECTE + credentials/config never returned or stored in
  plaintext, connection test → CONNECTE / ERREUR with a leak-free message,
  RBAC denial, shipment creation persists exactly OZ's response,
  ECHEC + `shipment.creation_failed` audit on carrier rejection, **no
  credential in any audit event**, cancellation exposed as the typed
  unsupported error (never a silent local cancel), status sync (mapped +
  unknown-preserved), and cross-provider-row credential isolation. (~15)

Full suite: **350/350 passing** (267 at end of Phase 22 + Phase 23
additions and the interim preloader work).

- **`typecheck`**: passes (`tsc --noEmit`, 0 errors).
- **`lint`**: passes (0 errors; 8 pre-existing `<img>` warnings in the
  unrelated preloader components).
- **`build`**: `next build` **fails at the committed `main` baseline** —
  `TypeError: Cannot read properties of null (reading 'useContext')` while
  prerendering `/_global-error` and `/acces-refuse`, caused by invalid
  React peer-dependency ranges in the lockfile
  (`lucide-react`, `class-variance-authority`, `styled-jsx` pinned to
  React 18 against a React 19 install). Verified identical with Phase 23
  changes stashed — **Phase 23 does not cause or worsen it**. Out of scope
  to fix here; flagged for a dedicated dependency-hygiene pass.
- **`git diff --check`**: clean. **secrets scan**: no hardcoded secrets;
  `.env` / `.env.test` are git-ignored. **No commit made.**

## Deferred (explicitly)
- **Enabling the adapter in production** — needs OzonExpress to confirm
  the API contract (or supply docs) + a verification pass against a real
  sandbox / low-value live parcel. Two-line change once done.
- **Live testing** — `LIVE_TESTED = NO`. No OzonExpress merchant account
  or credentials exist in this environment.
- **The OzonExpress city catalogue** — currently an operator-maintained
  `cityIdByName` map in connector config. If OzonExpress exposes a real
  `cities` endpoint, a future change can fetch and cache it.
- **Delivery-note (Bon de Livraison) / label-PDF flow** — OzonExpress's
  4-step `add-delivery-note` → `add-parcel-to-delivery-note` →
  `save-delivery-note` → PDF-URL process. Not modelled: the generic
  delivery layer has no "batch manifest / printable label" concept, and
  adding one is its own phase.
- **Bulk status polling** — `tracking` accepts an array; the current
  per-shipment "Synchroniser" calls it one parcel at a time. A batched
  poll job is a later optimization.
- **Return/refusal fee reconciliation** — see "Delivery cost".
- **Webhooks** — only if OzonExpress ever adds them.

## Future carrier integration model
This phase confirms the Phase 22 shape scales: a second Moroccan carrier
is a new `src/lib/integrations/delivery/providers/<carrier>/` directory
(client/errors/mapper/adapter, same layout), declaring only the
capabilities its API genuinely supports, plus one registration line in
`providers/index.ts`. A client using two carriers has two
`ShippingProvider` rows, each with its own encrypted credentials and
config; every shipment carries its own `providerId`, so operations never
cross carriers. No schema migration, no new Server Action, no new UI
screen — `credentialFields` lets each adapter describe its own config form.

## Live verification
`LIVE_TESTED = NO`. `FIXTURE_TESTED = YES` (full lifecycle, real test DB,
mocked HTTP). `CONTRACT_SOURCE = community-reconstructed, unverified`.
`PRODUCTION_REGISTERED = NO`.

---

# Phase 23 continuation — endpoint confirmation, production registration, `/cities` (2026-09-01)

## What the owner provided
The owner supplied OzonExpress's API documentation confirming these
endpoints and path-based (`customer id` + `api key`) authentication:

| Purpose | Endpoint |
| --- | --- |
| Create shipment | `POST /customers/{CUSTOMER_ID}/{API_KEY}/add-parcel` |
| Parcel details | `POST /customers/{CUSTOMER_ID}/{API_KEY}/parcel-info` |
| Tracking / status | `POST /customers/{CUSTOMER_ID}/{API_KEY}/tracking` |
| Destination catalogue | `GET /cities` |

This confirms the three endpoints Phase 23 already reconstructed and adds
`GET /cities` as the **authoritative city catalogue** (Phase 23 had only an
operator-maintained map). It does **not** yet include a transcription of
the exact request-parameter lists or response envelopes into this repo, and
**no real authenticated call has been made** (no test credentials were
provided). The documentation contains **no** cancellation endpoint and
**no** webhook/callback mechanism — `CANCEL_SHIPMENT` and `WEBHOOKS` remain
undeclared.

## Changes

### Production registration (the UI fix)
`src/lib/integrations/delivery/providers/index.ts` now calls
`registerOzonExpressProvider()`. Effect:
- "OzonExpress (Maroc)" appears in the Livraison → Prestataires "Configurer"
  connector picker; the button is no longer disabled (it disabled only
  while the registry was empty).
- The typed credential form renders **Identifiant client OzonExpress**
  (text) + **Clé API OzonExpress** (password), French-first, assembled
  client-side into the encrypted credentials JSON.
- **Registration ≠ CONNECTE.** Saving credentials still lands on
  `CONFIGURE`; only a successful `testDeliveryProviderConnectionAction`
  (a real authenticated request) sets `CONNECTE`. Unchanged.
- `displayName` is now `"OzonExpress (Maroc)"` (the "— contrat non vérifié"
  suffix is dropped; the connection-status badge already conveys verified
  state). `OZONEXPRESS_VERIFICATION` is `"ENDPOINTS_CONFIRMED"` (was
  `"UNVERIFIED"`).

### `GET /cities` — authoritative catalogue
- New `OzonExpressClient.get(path)` — an **un-credentialed** `GET`
  (`/cities` per the documentation), with the same SSRF re-check, timeout,
  retry, and error normalization as `post()`.
- `mapper.parseCitiesResponse` → `DeliveryCity[]`, tolerating a bare array
  or a `{CITIES|cities|result|data:[…]}` wrapper and probing each entry's
  id/name across the common spellings; an entry missing an id **or** a
  name is dropped, never guessed; an unrecognisable body yields `[]`.
- `mapper.resolveCityId(city, config, catalogue)` resolution order:
  **(1)** `config.cityIdByName` override (operator correction / alias) →
  **(2)** the `GET /cities` catalogue (case-insensitive) → **(3)** typed
  `DeliveryConfigError`, never a guessed id.
- `adapter.createShipment` fetches `/cities` first and passes the catalogue
  to `buildAddParcelForm`; if `/cities` is unreachable it falls back to the
  override map alone, still erroring rather than guessing.
- New generic optional `DeliveryProviderAdapter.listCities?()` +
  `DeliveryCity` type — a real capability many regional COD carriers share,
  not an Ozon special-case.

### Safe verification path (no accidental COD shipment)
"Tester la connexion" is structurally incapable of creating a parcel (it
only calls `adapter.testConnection`; `createShipment` is a separate action
requiring an order). `testConnection` now:
1. `GET /cities` — proves reachability + documented format, and reports the
   city count. Non-fatal: a parse/HTTP failure here just omits the count.
2. an authenticated `parcel-info` lookup for the sentinel
   `"__connexion_test__"` — proves the credentials authenticate ("parcel
   not found" counts as success). Bad credentials → `DeliveryAuthError` →
   the provider row goes `ERREUR` + `lastError`.

New optional `DeliveryConnectionResult.details` (a
`Record<string, string|number>` of non-secret read-only facts) is surfaced
in the success toast — "Connexion réussie — villes desservies : 120" — and
stored in the `shipping_provider.connection_test_succeeded` audit event's
metadata (the adapter guarantees no credential/URL is ever in it).

### Idempotency / custom tracking number
Unchanged: the local `Shipment.id` is sent as the `add-parcel`
`tracking-number`. Whether OzonExpress accepts an arbitrary custom value
and dedupes on it is stated by the community reconstruction but not yet
confirmed against the documentation body — the adapter reads back whatever
`TRACKING-NUMBER` the response carries either way, so correctness does not
depend on it.

## What is NOT done (needs an owner action)
- **A real authenticated call.** No OzonExpress test/live credentials were
  provided. `credentials authentication`, `/cities` retrieval, response
  format, tracking response, and the `DELIVERED-PRICE` / `RETURNED-PRICE` /
  `REFUSED-PRICE` fields have **not** been observed on a live response.
- **Transcribing the documentation body.** The request-parameter lists and
  response envelopes in `types.ts` / `mapper.ts` are still the resilient
  Phase 23 reconstruction (defensive parsing, tolerant of extra keys). They
  should be tightened to the documentation's exact field names, and the
  status vocabulary in `mapper.ts` reconciled against the documentation's
  status list, before auto-transitions are relied on.
- **No real parcel was created** and none should be until the above is
  done — then a single low-value live parcel to confirm `add-parcel`.

## Verification (this amendment)
- Tests: **369/369 pass** (+19 vs. the Phase 23 commit — `parseCitiesResponse`,
  catalogue-based city resolution, `client.get`, `testConnection` city
  count + catalogue-unavailable fallback, production-registry wiring +
  masked-field exposure, audit-metadata safety).
- `typecheck`: clean. `lint`: 0 errors (2 pre-existing preloader `<img>`
  warnings). `git diff --check`: clean. Secrets scan: none; `.env*`
  git-ignored.
- `build`: still fails at the **pre-existing `main` baseline** (`useContext`
  null prerendering `/_global-error` + `/acces-refuse`, invalid React-18
  peer deps in the lockfile) — verified identical with this work stashed.
- **No commit made.**

## Follow-up fixes (same amendment)

### Provider deletion
`deleteShippingProviderAction` + a "Supprimer" button on every row of
Livraison → Prestataires (`ConfirmActionButton`, `delivery.manage` only,
disabled when the provider has shipments). Refused with a friendly message
if any `Shipment` still references it (`onDelete: Restrict`); its
`ShipmentWebhookEvent` rows cascade-delete. New audit action
`shipping_provider.deleted`. This closes the "no way to remove a test
provider" gap.

### Connection-test errors are now legible
Previously an unclassified OzonExpress `RESULT:ERROR` surfaced only as
"OzonExpress a retourné une erreur pour cette requête." — useless for
verification. `errorForApiMessage` now surfaces OzonExpress's **own
MESSAGE** for the unclassified case ("OzonExpress a refusé la requête :
…"), first run through `OzonExpressClient.redact` (this client's own
customer id + API key → «masqué») and a length/long-token safeguard. The
MESSAGE is server-authored diagnostic text, never a credential. Known
substrings (`city`, `api key`, `not found`, …) still map to the fixed
French strings. `testConnection`'s sentinel `parcel-info` lookup now treats
a malformed response (as well as "not found") as auth-OK, and lets every
other error — including the newly-informative refusal — propagate to the
operator.

## Status markers (updated)
`LIVE_TESTED = NO`. `FIXTURE_TESTED = YES`.
`ENDPOINTS = owner-confirmed (add-parcel, parcel-info, tracking, GET /cities)`.
`FIELD_SCHEMAS = reconstructed, pending documentation-body transcription`.
`PRODUCTION_REGISTERED = YES (configurable + testable; not auto-CONNECTE)`.
`REAL_PARCEL_CREATED = NO`.

---

# Phase 23 continuation — live `tracking` + `/cities` verification (2026-09-01)

A real OzonExpress account (id `70275`) was used for READ-ONLY calls — no
parcel was created.

## What the live API returned

### `POST /customers/{id}/{key}/tracking` (multipart, `tracking-number` empty)
```
{ "CHECK_API": { "RESULT": "SUCCESS", "MESSAGE": "Valide API Key" },
  "TRACKING": { "TRACKING-NUMBER": "", "RESULT": "SUCCESS",
                "MESSAGE": "Valid tracking number",
                "HISTORY": { "1": {STATUT,TIME,TIME_STR,COMMENT}, … },   // object keyed "1".."N"
                "LAST_TRACKING": { "STATUT": "…", "TIME": "…", "COMMENT": "…" } } }
```
- **`CHECK_API.RESULT === "SUCCESS"` (`MESSAGE: "Valide API Key"`) is the
  authentication signal** — no top-level `RESULT:ERROR`.
- `HISTORY` deserializes as an **object keyed by index string**, not an array.
- Real `STATUT` values seen: `Nouveau Colis`, `Attente De Ramassage`,
  `Ramassé`, `Reçu`, `Mise en distribution`.

### `GET /cities` (un-credentialed — confirmed)
```
{ "CITIES": { "37": { "ID":37, "REF":"AGA", "NAME":"Agadir",
                      "DELIVERED-PRICE":35, "RETURNED-PRICE":0, "REFUSED-PRICE":10 }, … } }
```
- **801 cities**, each with the carrier's **authoritative per-city
  delivery price**. `CITIES` is an object keyed by id.
- `GET …/customers/{id}/{key}/cities` returns only `CHECK_API` — the
  credentialed path is NOT the catalogue; `GET /cities` is.

## Changes

| Area | Change |
| --- | --- |
| `types.ts` | `tracking` schema rewritten to the real `{CHECK_API, TRACKING:{HISTORY (array\|record), LAST_TRACKING}}` envelope. `/cities` schema: `CITIES` accepts an array **or** an id-keyed record; city entry now carries `DELIVERED-PRICE`/`RETURNED-PRICE`/`REFUSED-PRICE`. |
| `mapper.ts` | New `parseOzonExpressCities` → `OzonExpressCity[]` (id, name, ref, 3 prices); `parseCitiesResponse`/`toDeliveryCities` give the generic view. New `resolveCity` returns `{id, deliveredPrice}` (config override → catalogue → typed error). `readCheckApiMessage` extracts the auth message. `parseTrackingResponse` reads `TRACKING.LAST_TRACKING.STATUT` → last `HISTORY` entry → legacy fallbacks. Status table updated with the 5 confirmed live statuses (`Ramassé`/`Reçu` → `EN_TRANSIT`); delivered/returned/refused/cancelled wording still marked unconfirmed. |
| `adapter.ts` | `testConnection` now does `POST tracking` (empty code) and surfaces `CHECK_API.MESSAGE` as `details["authentification"]`; the bad-key `CHECK_API.RESULT:ERROR` is turned into `DeliveryAuthError` by the client. `fetchCities` = `GET /cities` only. `createShipment` sets `cost = add-parcel cost ?? the resolved city's DELIVERED-PRICE` — never a guess. `OZONEXPRESS_VERIFICATION = "TRACKING_LIVE_VERIFIED"`. |
| `client.ts` | `assertNoApiError` doc clarified: a `RESULT:"SUCCESS"` block (e.g. `CHECK_API`) is left alone; only `RESULT:"ERROR"` (top-level or one level nested) raises. |

## Answers

| Question | Answer |
| --- | --- |
| Real authentication succeeded? | **YES** — `CHECK_API: {RESULT:"SUCCESS", MESSAGE:"Valide API Key"}`. |
| `/cities` succeeded? | **YES** — `GET /cities`, 801 cities, all with `DELIVERED-PRICE`. |
| Any real parcel created? | **NO.** Only `tracking` (empty code) and `GET /cities` were called. |
| `add-parcel` verified? | **NO** — still the reconstruction. Needs one real low-value parcel. |
| Delivered/returned/refused/cancelled status wording | **NOT yet seen** — the mapper's entries for those remain a documented best-guess. |

## Verification (this amendment)
385 tests pass (fake now mirrors the real `CHECK_API`/`TRACKING`/`CITIES`
shapes; a live Zod check confirmed the `/cities` schema against all 801
rows). typecheck + lint clean. `next build` still fails only at the
pre-existing `main` baseline. Not committed.

## Status markers (updated again)
`TRACKING_ENDPOINT = LIVE_VERIFIED`. `CITIES_ENDPOINT = LIVE_VERIFIED`.
`AUTH = LIVE_VERIFIED (CHECK_API)`. `ADD_PARCEL = reconstructed, not live`.
`REAL_PARCEL_CREATED = NO`.
