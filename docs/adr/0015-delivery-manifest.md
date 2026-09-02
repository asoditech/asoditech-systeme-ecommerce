# ADR 0015 — Delivery manifest / Bon de Livraison / printable labels

## Status
Accepted (2026-09-01)

## Context
`docs/adr/0006-delivery-providers.md` listed **label generation** as
explicitly deferred. `docs/adr/0013-ozonexpress-integration.md`'s "Deferred"
section named the concrete gap:

> **Delivery-note (Bon de Livraison) / label-PDF flow** — OzonExpress's
> 4-step `add-delivery-note` → `add-parcel-to-delivery-note` →
> `save-delivery-note` → PDF-URL process. Not modelled: the generic
> delivery layer has no "batch manifest / printable label" concept, and
> adding one is its own phase.

This is that phase. It is a real daily operation: a Moroccan last-mile
merchant groups the day's parcels onto one handover document (bordereau /
bon de livraison), prints it plus the parcel labels, and gives the batch
to the carrier. Without it, an operator can create OzonExpress shipments
in ASODITECH but must still produce every piece of handover paperwork in
the OzonExpress portal by hand — the integration stops one step short of
the actual workflow.

The OzonExpress endpoints and portal PDF URLs are **owner-provided
documentation** seen in the live authenticated client portal
(`client.ozoneexpress.ma/doc`) on 2026-09-01 — not reconstructed or
guessed. They have **not** been run against the live API (creating a real
delivery note dispatches real courier paperwork); this ADR follows the
same posture as `add-parcel` — defensive parsing, a clear
`MANIFEST_LIVE_TESTED = NO` marker, real when verified.

## Decision — generic capability first, OzonExpress implements it

### 1. New capability `GENERATE_MANIFEST` (`src/lib/integrations/delivery/types.ts`)
A carrier "delivery note" / manifest / bordereau is a common last-mile
concept, not an OzonExpress quirk. It joins the existing
`DeliveryCapability` union alongside `CREATE_SHIPMENT` / `CANCEL_SHIPMENT`
/ `FETCH_STATUS` / `FETCH_COST` / `WEBHOOKS`, declared only by adapters
whose API genuinely has the workflow, and checked with the same
`assertCapability()` → typed `DeliveryUnsupportedCapabilityError` (never a
silent no-op) as every other capability.

### 2. Outcome-oriented adapter method, not step-oriented
```ts
generateManifest?(
  { externalIds: string[] },   // the carrier's own shipment ids
  credentials, config
): Promise<{
  externalRef: string;                    // the carrier's BL reference — required, never fabricated
  parcelCount: number | null;             // only if the carrier's response reports one; never inferred from input length
  documents: { label: string; url: string }[];  // printable-document links (https-only), [] if none
}>
```
Whatever multi-call dance the carrier needs is the adapter's concern —
same principle as `FETCH_COST` (`docs/adr/0012`): the caller sees the
outcome, not the steps. OzonExpress's four steps
(`add-delivery-note` → `add-parcel-to-delivery-note` →
`save-delivery-note` → build portal URLs) all live inside its
`adapter.generateManifest`.

### 3. Printable documents are operator-opened links — never fetched server-side
`documents[].url` is opened by the operator in their **own browser**,
where they are already signed into the carrier portal. This app **never**
fetches, proxies, or renders these PDFs. Reasons:
- The portal's auth for these URLs is not documented and not something to
  assume; a server-side fetch built on a guess would be exactly the
  "fabricated external API behaviour" the brief forbids.
- It keeps the carrier's portal as the single source of truth for the
  document's contents.
- The adapter contract requires each `url` to be an absolute `https:` URL;
  `service.ts` re-filters the list (drops any non-`https:` / malformed
  entry) before it lands in the JSON column a page renders as `<a href>`.
  The OzonExpress config's optional `portalBaseUrl` override is
  `https:`-validated by its Zod schema so a misconfiguration can't inject
  a `javascript:` href.

### 4. Schema (migration `20260901221642_delivery_manifest`)
```
enum DeliveryManifestStatus { BROUILLON  FINALISE  ECHEC }

model DeliveryManifest {
  id, providerId, externalRef?, status, parcelCount,
  documents Json @default("[]"),   // [{ label, url }]
  failedReason?, createdAt, updatedAt, createdById?
  provider  ShippingProvider @relation(onDelete: Restrict)  // history is kept
  shipments Shipment[]
}
// Shipment gains: manifestId String?  (onDelete: SetNull, indexed)
```
A manifest belongs to **one** provider row (never mixes carriers). A
shipment is on **at most one** manifest — `manifestId` is set once, when
the batch is finalised. No new registry table — this is additive to the
`ShippingProvider` / `Shipment` schema, same as `docs/adr/0012`'s Phase 22
additions.

### 5. Service orchestration (`generateManifestViaProvider`)
Pre-flight is **all-or-nothing before any local row or network call**:
every selected shipment must exist, belong to the given provider, be
API-created (`externalId` set), not already be on a manifest, and be
**`EN_ATTENTE`** — i.e. registered with the carrier but not yet handed
over. `EN_TRANSIT` means the carrier already has the parcel; a terminal
status means it's done — putting either on a new handover document is a
mistake, so the whole selection is **rejected** (`ManifestSelectionError`,
French message) rather than silently filtered.

Then: a local `DeliveryManifest` (`BROUILLON`) is created → the adapter is
called → on success the manifest is finalised (`externalRef`,
`parcelCount = carrier's count ?? selection size`, sanitised `documents`,
`FINALISE`) and every still-eligible shipment is linked, **atomically**;
on adapter failure the manifest is marked `ECHEC` with a safe reason, **no
shipment is linked**, and the typed error propagates. Mirrors
`createShipmentViaProvider`'s "never a fake success, never a dangling row"
contract from `docs/adr/0012`.

### 6. Server Action, RBAC, audit
`generateDeliveryManifestAction` — gated on the existing
`delivery.manage` permission (server-side `requirePermissionForAction`, not
just UI). Two new `AuditAction` values following the `entity.verb`
convention: `delivery_manifest.created` (on `DeliveryManifest`) and
`delivery_manifest.failed` (on `ShippingProvider`, when the batch is
rejected or the carrier fails). No credential, key, or URL is ever in the
audit metadata — same guarantee as every other delivery action.

### 7. UI — Livraison → "Bons de livraison" tab
Shown **only** when a registered API provider's adapter declares
`GENERATE_MANIFEST` and the user has `delivery.manage`. Two sections:
- **`ManifestBuilder`** — the `EN_ATTENTE` API shipments not yet on a
  manifest, grouped by provider, with per-parcel checkboxes and one
  "Générer le bon de livraison" button per provider group (a manifest
  never mixes carriers).
- **Manifests list** — each row's `documents` rendered as
  `target="_blank" rel="noopener noreferrer"` buttons; an `ECHEC` row
  shows its `failedReason` instead.

All French, reusing `StatusBadge` + a new
`DELIVERY_MANIFEST_STATUS_LABELS` map (no ad-hoc label strings).

## OzonExpress implementation (adapter/mapper)
| Step | Call | Response handling |
| --- | --- | --- |
| 1 | `POST add-delivery-note` (no fields) | `parseDeliveryNoteRef` — flat `ref` (per the owner PHP example) or `REF`/`Ref`/`DELIVERY-NOTE.ref`/`ADD-DELIVERY-NOTE.ref`; **throws** `DeliveryMalformedResponseError` if none — never a fabricated ref |
| 2 | `POST add-parcel-to-delivery-note` `Ref` + `Codes[0..n]` | no documented body; success = the client's `assertNoApiError` doesn't throw |
| 3 | `POST save-delivery-note` `Ref` | same |
| 4 | — | `buildDeliveryNoteDocuments(ref, config)` → the 3 documented portal URLs (`pdf-delivery-note`, `pdf-delivery-note-tickets`, `pdf-delivery-note-tickets-4-4`), `dn-ref`-encoded, from `portalBaseUrl` (default `https://client.ozoneexpress.ma`) |

Every call goes through the existing `OzonExpressClient` — path-based
auth (URL is a secret, never logged/thrown), SSRF re-check before each
request, timeout, retry, HTTP-200-`RESULT:ERROR` unwrapping. No new
transport code.

## Test matrix
`tests/lib/delivery-manifest.test.ts` (new, 17 tests):
- mapper: `parseDeliveryNoteRef` (flat / capitalised / nested / **throws, never fabricates**), `buildDeliveryNoteDocuments` (3 URLs, ref-encoding, https-only, `portalBaseUrl` override)
- adapter vs fake OzonExpress HTTP: the 4-step flow, `Codes[i]` placement, api-key-never-in-a-query-string, nested-ref tolerated, carrier `RESULT:ERROR` at **each** step → typed error, no-ref response → malformed
- capability gating: `assertCapability` throws for an adapter without `GENERATE_MANIFEST`
- service vs the reference fixture adapter + real test DB: `FINALISE` links every shipment + stores https docs + passes our external ids to the carrier; selection rejected (no local row) for mixed providers / manual shipment / already-manifested / not-`EN_ATTENTE`; carrier failure → `ECHEC`, nothing linked; no-ref → `ECHEC`

`tests/actions/ozonexpress-provider.test.ts` (+3): action generates + links + audits + https-only docs + **no api key in audit**; denied without `delivery.manage`; mixed-provider batch → `actionError` + `delivery_manifest.failed` audit + zero manifest rows.

Existing capability-snapshot assertions in `ozonexpress-adapter.test.ts`,
`delivery-production-registry.test.ts`, `ozonexpress-provider.test.ts`
updated to include `GENERATE_MANIFEST`. The reference fixture adapter +
its fake HTTP gained a `generateManifest` / `/manifests` implementation
(test code only — never in `providers/index.ts`).

## Deferred (explicitly, not silently)
- **Live verification** — `MANIFEST_LIVE_TESTED = NO`. The endpoints and
  portal URLs are owner-documented but not yet run against the real API.
  One real low-value delivery note closes it; no code change expected if
  the responses match the defensive schemas.
- **Retry-induced duplicate delivery notes.** Phase 26 structural audit
  finding: `OzonExpressClient.post()` (`client.ts`) automatically retries
  on network failure and on HTTP 429/5xx, up to `MAX_RETRIES`, with no
  regard for whether the carrier already processed the request before the
  response was lost — the same category of risk `add-parcel` closes with
  an idempotency key (the local `Shipment.id` as `tracking-number`, so a
  retried create is rejected as a duplicate by OzonExpress itself). Unlike
  `add-parcel`, none of the three manifest-flow calls
  (`add-delivery-note` → `add-parcel-to-delivery-note` →
  `save-delivery-note`) carry an equivalent key — `add-delivery-note`
  in particular takes no fields at all, so a retried call after a
  transient 5xx could mint a second, unrelated delivery-note reference on
  OzonExpress's side with no local way to detect or dedupe it. This is
  not fixed here: doing so would mean guessing at an idempotency
  mechanism OzonExpress's documentation doesn't describe, which is
  exactly the "fabricated external API behaviour" this ADR's own
  decision #3 and `docs/adr/0013`'s posture forbid. **Before the first
  live manifest generation**, either confirm with OzonExpress whether
  `add-delivery-note` accepts a client-supplied reference, or reduce
  `MAX_RETRIES` to 0 for this specific three-call sequence and surface a
  retryable `ECHEC` to the operator instead of retrying automatically.
- **Removing a shipment from a manifest / voiding a manifest** — OzonExpress
  documents no such endpoint. A wrongly-built manifest is retried as a
  fresh one; the mistaken parcels stay linked to the `ECHEC`/old row.
- **Server-side PDF retrieval / storage** — see decision #3. If OzonExpress
  ever documents an authenticated PDF-download endpoint, a later change
  could fetch-and-store; today the operator opens the portal link.
- **Manifest for `MANUEL` / `FLOTTE_INTERNE` providers** — those have no
  carrier API to generate a document; an internal packing-slip PDF is a
  separate, unrelated feature.
- **A second carrier's manifest** — additive: declare `GENERATE_MANIFEST`
  on its adapter and implement `generateManifest`. No schema, service,
  action, or UI change.

## Live verification
`MANIFEST_LIVE_TESTED = NO`. `FIXTURE_TESTED = YES` (full flow, real test
DB, mocked HTTP). `CONTRACT_SOURCE = owner-provided portal documentation,
2026-09-01`.
