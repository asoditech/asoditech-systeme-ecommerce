# ADR 0033 — « Suivi » tracking module

## Status
Accepted (2026-09-09). Builds on ADR 0012 (delivery provider adapter),
ADR 0013 (OzonExpress), ADR 0028 (Aramex), ADR 0031 (delivery/sync UX),
ADR 0032 (delivery cost rules).

## Context

The existing Livraison module already shows a shipment's local status
(`ShipmentStatus`), the carrier's raw status string (`providerStatusRaw`),
and a single "Synchroniser" action per row plus a bulk "Rafraîchir les
statuts". That is enough to run fulfilment, but not enough to *answer
customers*: there is no consolidated view of where every parcel is, no
event history, no normalized vocabulary across carriers, and no place that
is obviously "the tracking screen".

The owner asked for a **new, independent** tracking module — explicitly
**without touching** any existing delivery logic.

## Decision

Add a read-mostly « Suivi » area at `/livraison/suivi`, layered strictly
*on top of* the existing delivery data and services.

### What is NOT changed

- No existing file's behaviour changes. `ShipmentStatus`, the local state
  machine, `syncShipmentStatus`, `applyShipmentStatusTransition`, cost
  finalization (ADR 0032), invoices, manifests, webhooks — untouched.
- The old per-row "Synchroniser" and bulk "Rafraîchir les statuts" stay
  exactly as they are.
- No new Order / Shipment-like model. No duplicated business logic.

### Schema — additive only

Five nullable columns on `Shipment`, written **only** by the new refresh
flow, read **only** by the new module:

| column | purpose |
|---|---|
| `trackingEvents` (JSONB) | normalized carrier event history, last synced |
| `courierName` / `courierPhone` | delivery person, **iff** the carrier API returns one (neither current carrier does) |
| `lastTrackingSyncAt` | rate-limit + "synchronisé il y a 2 min" anchor |
| `trackingSyncError` | last FETCH_TRACKING failure message; events above kept as last-known-good |

Migration `20260909230000_tracking_module` — five `ADD COLUMN`, all
nullable, zero backfill, no index (the module filters on existing indexed
columns).

### Adapter extension — backward-compatible

- New capability `FETCH_TRACKING` and new **optional** method
  `fetchTracking?()` on `DeliveryProviderAdapter`. Adapters without it are
  unaffected; the module degrades to "pas d'historique détaillé".
- OzonExpress `fetchTracking` parses `TRACKING.HISTORY`
  (`{STATUT, TIME, TIME_STR, COMMENT}`). No courier / structured location
  in its response → returned `null`, never fabricated.
- Aramex `fetchTracking` parses `TrackShipments` → `TrackingResults`
  updates, keeping `UpdateLocation` as the event location string. No
  courier field → `null`.
- Both reuse their existing `parseTrackingResponse` for envelope
  validation, so status/cost parsing stays single-sourced.

### Normalized status layer — `src/lib/tracking/status.ts`

`NormalizedTrackingStatus` (11 values: CREATED, PICKUP_PENDING, PICKED_UP,
IN_TRANSIT, AT_DEPOT, OUT_FOR_DELIVERY, DELIVERED, RETURNED, FAILED,
CANCELLED, UNKNOWN) with French labels + badge tones.

`normalizeTrackingStatus(localStatus, providerStatusRaw)`:
- A **terminal** local status (LIVRE / RETOURNE / ECHEC / ANNULE) maps
  1:1 and is **never** overridden by raw text.
- A non-terminal local status is *refined* into a nicer bucket using
  keyword rules against the accent-stripped raw string (out-for-delivery,
  depot, picked-up, in-transit, pickup-pending).
- No usable raw string → coarse fallback (EN_TRANSIT→IN_TRANSIT,
  EN_ATTENTE→CREATED). It never returns UNKNOWN from a *known* local
  status — UNKNOWN is only for genuinely unmapped input.

The carrier's original string is always kept and displayed alongside.

### Refresh service — `tracking-service.ts`

`refreshShipmentTracking({ shipment, order, updatedById })`:

1. Calls the **existing** `syncShipmentStatus` verbatim — status + cost
   stay correct with all of ADR 0031/0032's own safety. On its error, we
   only stamp `lastTrackingSyncAt` + `trackingSyncError`; nothing else
   moves.
2. If the provider declares `FETCH_TRACKING`, pull events + courier and
   persist them. **On failure here the previously-stored events and status
   are kept** — only `trackingSyncError` + `lastTrackingSyncAt` change.
   A carrier outage can never blank a valid last-known status.

Actions (`src/actions/tracking.ts`): `refreshTrackingAction` (single) and
`refreshTrackingBatchAction` (bounded batch of 6, client loops while
`hasMore`, oldest `lastTrackingSyncAt` first — Vercel Hobby ~10 s safe,
mirrors `refreshShipmentStatusesAction`). Both gated on `delivery.manage`,
both audited as `shipment.tracking_refreshed`.

### UI

- Sidebar: flat "Suivi" item under "Livraison" in the Ventes group
  (`delivery.view`). The active-state logic now prefers the most specific
  matching href so "Livraison" doesn't stay lit on `/livraison/suivi`.
- `/livraison/suivi` — 5 clickable KPI cards, filter bar (search / status /
  transporteur / ville / source de coût / période presets), table,
  URL-driven pagination. Cost column + cost-source filter shown only with
  `finance.view`.
- `/livraison/suivi/[shipmentId]` — status, courier ("Non disponible" when
  the carrier gives none), destination, colis, recorded cost
  (`finance.view` only, reads the frozen ADR 0032 value, never recomputes),
  and the carrier event timeline.

### Permissions

| capability | gate |
|---|---|
| view list + detail | `delivery.view` |
| refresh (single + batch) | `delivery.manage` |
| see cost column / cost-source filter / cost card | `finance.view` |

### Future public tracking page

The normalized layer + `trackingEvents` are deliberately shaped to feed a
future customer-facing tracking page. That page is **not** built here.

## Consequences

- A carrier with no `fetchTracking` still works — the module shows the
  normalized status from the local state + raw string, and says the
  carrier provides no detailed history.
- `trackingEvents` is a snapshot, not an append log: each successful
  refresh replaces it with the carrier's current full history (carriers
  return the whole list each call). Historical events are preserved on a
  *failed* refresh, not across a *successful* one that returns fewer.
- Removing the module = delete the route + `src/lib/tracking` +
  `tracking-service.ts` + the five columns. Nothing else references them.
