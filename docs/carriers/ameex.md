# Ameex (Maroc) — delivery adapter

**Status: `SANDBOX_VERIFIED_2026_10_16` · registered and selectable for new connections · production NOT verified.**

Code: `src/lib/integrations/delivery/providers/ameex/` · Tests: `tests/lib/ameex-*.test.ts` (fetch and DNS are stubbed; no test touches the network).
Evidence: `tests/fixtures/ameex/sandbox-responses-2026-10-16.json`. These are real sandbox responses from owner-authorized calls made on 2026-10-16 with a `test_` key, using a fictitious `SBX-` parcel. Credentials were removed. Every request and response shape the adapter relies on comes from this file.

`providers/index.ts` calls `registerAmeexProvider()`. The « Configurer » dialog shows the notice `AMEEX_SANDBOX_ONLY_NOTICE` (sandbox only, provisional status mapping). The same rule as the other carriers applies: saving credentials gives CONFIGURE, and only a successful real « Tester la connexion » gives CONNECTE.

## Contract (sandbox-verified)

- Base URL `https://api.ameex.app/customer` is fixed (no tenant override). The auth headers `C-Api-Id` / `C-Api-Key` go on every request. A key starting with `test_` uses the sandbox at the same URLs. The rate limit is 60 calls/min.
- **Envelope**: `{ login: "success", api: { type: "success" | "error", msg, …, sandbox } }`.
  - **Business errors arrive as HTTP 200** with `api.type: "error"` and a short English `msg` (no field codes).
  - `assertAmeexEnvelope` turns an error envelope into `DeliveryConfigError`. The message is a fixed French text with a hint for known cases: unknown city, or « The X field is required. » (only the field name is extracted). Ameex's free-text `msg` is never echoed.
  - `login` ≠ `"success"` gives `DeliveryAuthError`. An unrecognizable body gives `DeliveryMalformedResponseError`.
- `GET /Delivery/Parcels/Statuts` returns `api.data.status = { CODE: { type, name, color } }`, 36 codes in total. `type: "fixed"` marks a main status. `type: "in_progress"` marks a sub-status sent in `statut_s` while the main status is `IN_PROGRESS`.
- `GET /Delivery/Cities` returns `api.cities = { "<id>": { id, name } }`, with 591 cities on the sandbox (Casablanca = 129).
- `POST /Delivery/Parcels/Action/Type/Add` **requires `application/x-www-form-urlencoded`**. A JSON body was refused with HTTP 200 and « The receiver field is required. ».
  - Fields: `type=SIMPLE`, `receiver`, `phone`, `city` (Ameex id), `cod`, `address`, `product`, `comment`, `order_num`.
  - Success: `api.data.code = "SBX-…"`. No fee and no status are returned.
- `GET /Delivery/Parcels/Tracking/ParcelCode/{code}` returns `api.tracking = [ { type, statut, statut_name, statut_color, statut_s, statut_s_name, statut_s_color, sorting_time, time, time_str, comment } ]`. `sorting_time` and `time` are **Unix seconds**.
- `MassTracking` / `MassInfo` (form field `codes`) were observed, keyed by parcel code. They are **not wired**, because the adapter contract has no bulk operation.

## Capabilities

| Capability | Implementation |
|---|---|
| `testConnection` | `GET Statuts` + envelope check. `details = { mode: sandbox\|production (key prefix), statuts: <count> }`. Creates nothing. |
| `FETCH_CITIES` | `GET Cities`. City ids are numeric strings. They feed the generic city-mapping layer. |
| `CREATE_SHIPMENT` | `postOnce(…, "form")`, **one attempt**. A missing or non-numeric city id, or a negative COD, gives `DeliveryConfigError` before sending. An error envelope gives a definite `DeliveryConfigError`. Timeout, reset, 5xx, 429, **408, 409 or any other unexpected HTTP status**, an unreadable 2xx, a success without `data.code`, or any untyped error after the request was sent give `DeliveryOutcomeUnknownError` (shipment « à vérifier »). Only 400/401/403/404/422 are definite HTTP refusals (`isDefiniteCreateRefusalStatus`, `src/lib/integrations/delivery/errors.ts`, 2026-10-16); 401/403 → `DeliveryAuthError`. A connection that was never established (DNS, refused) stays a definite `DeliveryUnavailableError`. `externalId = trackingNumber = data.code`. |
| `FETCH_STATUS` | Tracking GET, latest event by `sorting_time` (stable for ties). Raw = `statut`, or `statut/statut_s` when a sub-status is present (e.g. `IN_PROGRESS/NO_ANSWER`). |
| `FETCH_TRACKING` | Same GET. Events oldest-first: label = sub-status name, else status name; description = comment; ISO timestamp from seconds. No courier or location (Ameex gives none). |
| `WEBHOOKS` | HMAC `X-Ameex-Signature` (unchanged), sandbox filter. `rawStatus` uses the same composition. `handleDeliveryWebhook` then re-fetches through `fetchStatus`, which now exists, so a verified webhook ends in a real status sync. |

Still **blocked** (`AMEEX_BLOCKED_CAPABILITIES`): `CANCEL_SHIPMENT`, `FETCH_LABEL`, `GENERATE_MANIFEST` and `FETCH_COST` (all undocumented), plus `MASS_TRACKING` (no bulk hook).

## Status mapping — PROVISIONAL (`AMEEX_STATUS_MAPPING_STATUS`, owner review pending)

| Local | Ameex codes |
|---|---|
| `EN_ATTENTE` | DRAFT, NEW_PARCEL, WAITING_PICKUP |
| `EN_TRANSIT` | PICKED_UP, RECEIVED, IN_SHIPMENT, SENT, TRAVELLING, DISTRIBUTION, IN_PROGRESS, CONFIRMED_BY_LIVREUR, SCHEDULED, DISPOSITION, POSTPONED(_TEAM), NO_ANSWER(_SMS/_TEAM), UNREACHABLE(_TEAM), VOICEMAIL(_TEAM), RELAUNCH(_NEW/_TEAM), RESEND_NEW_CITY, PREPAR_RETURN |
| `LIVRE` | DELIVERED |
| `RETOURNE` | RETURNED |
| `ECHEC` | REFUSE, CANCELED, CANCELED_TEAM, DOESNT_ORDER, WRONG_NUMBER, OUT_OF_AREA |
| `null` (raw kept) | REFUNDED (ambiguous: COD remitted or customer refund?), any unknown code, any unknown sub-status under IN_PROGRESS |

Under `IN_PROGRESS`, the sub-status decides. On any other main status, a stray sub-status is ignored.

Legality was checked against `SHIPMENT_STATUS_TRANSITIONS` in `tests/lib/ameex-status.test.ts`:
- every target is reachable from `EN_ATTENTE`;
- after `ECHEC`, these remain legal: `RETOURNE` (a later RETURNED), `EN_TRANSIT` (RELAUNCH / PREPAR_RETURN) and `LIVRE`. Refusal-type codes can therefore safely map to `ECHEC`.

Review points:
- a `PREPAR_RETURN` after a refusal moves the shipment `ECHEC → EN_TRANSIT` until RETURNED;
- `CANCELED` (an Ameex sub-status, not our cancellation) maps to ECHEC;
- `DISPOSITION` maps to EN_TRANSIT.

## Webhook policies (ours, since Ameex documents none)

- **Unsigned deliveries are rejected.** The webhook secret is required, both chez Ameex and in the connection's credentials.
- `t` is read as Unix **seconds**, with a tolerance of ±300 s. Every Ameex timestamp seen on the sandbox is in seconds, which supports this, but no real signed webhook has been received yet.
- Dedupe id = `sha256(t + "." + rawBody)`. `SANDBOX=1` events received on a live key are ignored.
- The URL to give Ameex is `https://<domaine>/api/webhooks/delivery/<ShippingProvider.id>`. Since 2026-10-16 it is shown ready to copy in the connection's « Configurer » dialog (read-only field « URL du webhook à coller chez le transporteur », displayed for connectors declaring `WEBHOOKS` — `src/components/delivery/provider-connection.tsx`). Until then the connection id was not shown and the guide said to ask support.

## Open points

1. **Production key not tested.** Nothing has been sent with a live key, and production response shapes are assumed identical to the sandbox ones.
2. Status mapping needs owner review (see above). Only `NEW_PARCEL` has been observed, on a single sandbox parcel.
3. Cancellation, labels, bordereaux and prices are undocumented and not built.
4. Prepaid orders are sent with `cod=0`, which has not been observed on the sandbox.
5. The phone number is sent trimmed only. Which formats Ameex accepts is unconfirmed.
6. The response to a bad key is unobserved. Both 401/403 and `login` ≠ success are mapped to `DeliveryAuthError`.
7. No real signed webhook has been received. The seconds unit and header format are unconfirmed live.
8. ~~The webhook URL / connection id should be shown in the « Prestataires » UI.~~ Resolved 2026-10-16: shown in « Configurer » (see « Webhook policies »).
9. HTTP 408 / 409 on creation have never been observed. Since 2026-10-16 they are « à vérifier » (a server can time out after acting); if Ameex documents them as a guaranteed no-op, they can become definite refusals.
