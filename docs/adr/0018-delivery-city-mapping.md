# ADR 0018 — Generic delivery-provider city mapping

## Status
Accepted (2026-09-03)

## Context
A local order carries a free-text `shippingCity` ("Casablanca"). A delivery
provider needs its **own** destination identifier for that city, and every
provider's scheme is different — OzonExpress uses numeric ids from a
`GET /cities` catalogue; another carrier might use `CAS-01`, a region code,
or expose no catalogue at all. The same local city therefore has an
independent mapping per `ShippingProvider`.

`docs/adr/0013-ozonexpress-integration.md` (Phase 27B) already added the
safe-matching primitives (`city-match.ts`: `normalizeCityName`,
`matchCityName` — harmless case/accent/whitespace differences only, never a
"closest" guess; ambiguity and no-match are always reported). OzonExpress's
adapter also has a `config.cityIdByName` override map. What was missing: a
**persistent, provider-agnostic** override an operator can record once and
have every future shipment use — and a single resolver that composes all of
this in a defined order.

The system must never guess a destination id, and a purely local
resolution failure must never reach an external call.

## Decision

### Data model — `DeliveryCityMapping`
One row = one local city pinned to one provider's own city id.

```
id, shippingProviderId, localCityKey, localCityLabel,
providerCityId, providerCityName, createdAt, updatedAt
@@unique([shippingProviderId, localCityKey])
```

- `localCityKey` — the shared `normalizeCityName()` output (the lookup key).
- `localCityLabel` — the city as the operator typed it (display/audit only).
- `providerCityId` — the provider's identifier **verbatim as a string**
  (a numeric id is stored as its string form; never parsed, never assumed
  numeric).
- `providerCityName` — the provider's own name for that city, taken from
  its catalogue, kept for display / debugging / audit.
- No credential or secret material. `onDelete: Cascade` — a mapping is
  per-provider configuration (like credentials), not history.
- The `@@unique` is the real guard against a duplicate created by two
  concurrent requests (the actions rely on the P2002 backstop, not only a
  pre-check).

Nothing carrier-specific: there is no `ozonCityId` column and no
OzonExpress id is hardcoded anywhere.

### Capability — `FETCH_CITIES`
New `DeliveryCapability`. Declared **only** by a provider that both
implements `listCities` and genuinely needs a provider-specific
destination id. OzonExpress declares it (its `listCities` is live-verified
2026-09-01). A provider without it is treated as "no catalogue": no
provider city id is ever fabricated for it and the mapping UI says so.
Shipment creation does **not** depend on this capability.

### Resolver — `resolveProviderCity()` (`city-resolution.ts`)
Provider-agnostic, returns a typed result (never throws for a normal
unresolved/ambiguous state):

1. **explicit persisted `DeliveryCityMapping`** for (provider, key) →
   `{ status: "resolved", …, source: "mapping" }`. Returned verbatim —
   it wins over everything, even if the catalogue now spells the city
   differently or is unavailable.
2. **safe exact catalogue match** (`matchCityName`) →
   `{ status: "resolved", …, source: "catalogue" }`.
3. more than one normalized match → `{ status: "ambiguous", candidates }`.
4. none → `{ status: "unresolved", suggestions }`.

### Composition with the adapter's own fallback
Full precedence for a shipment:

```
DeliveryCityMapping
  → safe exact catalogue match          (both: generic resolver, in the service)
  → adapter last-resort (e.g. OzonExpress config.cityIdByName + catalogue)
  → typed failure — no external call
```

`createShipmentViaProvider` runs the generic resolver first (before the
local shipment row is even reserved). On `resolved` it passes
`CreateShipmentAdapterInput.resolvedProviderCityId` and the adapter uses it
verbatim. On `ambiguous`/`unresolved` it passes `null`; the adapter then
applies its own last-resort resolution and, failing that, throws a typed
`DeliveryConfigError` **before** any parcel is submitted. `config.cityIdByName`
is unchanged and still works — existing entries are neither migrated nor
removed.

### Operator UI
`Livraison → Prestataires` → per-API-provider **"Correspondances de villes"**
dialog (`city-mapping-dialog.tsx`). Lists mappings, lets the operator add /
change / delete one, choosing the provider city **from the provider's real
catalogue only** — never a free-text id, never a fuzzy auto-selection. For
a provider that exposes no catalogue it shows a clear message instead of a
form. The catalogue is a live provider call, so it is loaded lazily when
the dialog opens, not on every Livraison render.

### Server-side rules (never trust the client)
For every mutation: `requirePermissionForAction("delivery.manage")`; the
`ShippingProvider` must exist; the provider must expose a catalogue
(otherwise the mutation is refused — an id can't be validated);
`providerCityId` must be a real catalogue entry; `providerCityName` is
taken from that entry, not from the client; `localCity` is normalized with
the shared rules; a duplicate is refused (unique constraint + P2002).
Reading the mapping context needs `delivery.view`.

### Organization isolation
The deployment is single-tenant (`docs/adr/0002-domain-model.md`) — there
is no `Organization` / `tenantId`. Isolation is the existing pattern:
server-side RBAC plus `ShippingProvider` ownership/existence checks. An
update/delete re-derives the provider from the mapping row and validates
the new id against **that** provider's catalogue, so a mapping can't be
pointed at another provider's city.

### Audit
`delivery_city_mapping.created` / `.updated` / `.deleted`, entity type
`DeliveryCityMapping`, carrying provider id, local city, and provider city
id/name — never credentials or tokens.

## Consequences
- Any future provider that returns a catalogue reuses the model, the
  resolver, the actions and the UI unchanged — it only implements
  `listCities` and declares `FETCH_CITIES`.
- OzonExpress shipment creation now fetches `/cities` twice (once in the
  service resolver, once in the adapter). Acceptable — both are read-only
  and the connection-test diagnostic already does the same; a shared
  per-request cache is a possible later optimisation.
- No live external write was performed for this phase. No real parcel is
  created; only the read-only `GET /cities` catalogue is exercised, which
  the OzonExpress connection test already uses.

## Deferred
- An inline "map this city and retry" affordance on the create-shipment
  failure itself. For now the failure message points the operator to
  `Livraison → Prestataires → « Correspondances de villes »`, and the
  order stays in the "À expédier" list for a retry after the mapping is
  added.
- Bulk import of mappings.
