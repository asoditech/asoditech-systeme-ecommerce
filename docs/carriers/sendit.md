# Sendit — carrier integration

**Status: `IMPLEMENTED_FROM_OFFICIAL_SPEC_NOT_LIVE_TESTED` (2026-10-16).** Registered and selectable for new API connections, with a visible notice « Connecteur Sendit disponible mais pas encore validé sur un compte réel ». Nothing has been run against a real Sendit account; every request and response shape is covered only by stubbed-fetch unit tests.

Sources:
- the official public spec, https://app.sendit.ma/docs/api-docs.json (servers, `bearerAuth` security scheme, paths, status catalogue);
- the owner's Swagger export (`lvr societes APIs/sendit.rtf`, git-ignored) for the example request and response bodies.

## What the spec settles

- Base URL: `https://app.sendit.ma/api/v1/` (`servers`). The client hard-codes it and accepts no override.
- Auth: `POST /login { public_key, secret_key }` → `data.token`. Every other call sends `Authorization: Bearer <token>` (`securitySchemes.bearerAuth`: http, bearer, JWT).
- Paths used: `POST /deliveries`, `GET /deliveries/{code}`, `POST /deliveries/getlabels`, `GET /districts?page=N[&pickup-district=ID]`.

## Implemented

Code: `src/lib/integrations/delivery/providers/sendit/`. Tests: `tests/lib/sendit-{client,adapter,mapper,status,errors}.test.ts` (fetch stub: `tests/helpers/fake-sendit.ts`).

| File | Contents |
|---|---|
| `client.ts` | `SenditClient`: fixed https base, `assertPublicHost` before every request, 20 s timeout, `redirect: "error"`. Login and JWT cache are per credential pair, keyed by SHA-256 of the pair (never the raw keys), with a 20 min TTL. Reads (`get`, `postRead`) retry network/5xx/429 up to 3 attempts and re-login **once** on 401; a second 401 is a `DeliveryAuthError`. `createOnce` makes **one attempt**: timeout, reset, 5xx, 429, 408, 409, any other unexpected status or an unreadable 2xx → `DeliveryOutcomeUnknownError` (« à vérifier »); 401/403 → auth/permission error, with no re-login and no resend; 400/404/422/250/251/252 → definite typed error with a fixed French message. Since 2026-10-16 the definite-refusal list is the shared `isDefiniteCreateRefusalStatus` (`src/lib/integrations/delivery/errors.ts`: 400/401/403/404/422) plus Sendit's 250/251/252. |
| `adapter.ts` | `senditAdapter` (key `sendit`, « Sendit (Maroc) »), `acceptsNewConnections: true`, `notice`. |
| `types.ts` / `mapper.ts` / `status.ts` / `errors.ts` | Pure modules (schemas, create body, parsers, provisional status map, error mapping). New: `SENDIT_BASE_URL`, `labelPrintFormat` config, `parseDeliveryTracking` (audits → events), `composeSenditRawStatus` / `mapSenditRawStatus`, HTTP 400 → config error, `SENDIT_OUTCOME_UNKNOWN_MESSAGE`. |
| `index.ts` | Re-exports, `SENDIT_VERIFICATION`, `SENDIT_OPEN_QUESTIONS`, `registerSenditProvider()` (called from `providers/index.ts`). |

Capabilities declared: `CREATE_SHIPMENT`, `FETCH_STATUS`, `FETCH_TRACKING`, `FETCH_COST`, `FETCH_CITIES`, `FETCH_LABEL`.

- **Credentials:** `publicKey` (text) and `secretKey` (password). Both are encrypted at rest like every connector's credentials.
- **testConnection:** `POST /login` only, forced fresh. It creates nothing.
- **createShipment:** uses `input.resolvedProviderCityId` as `district_id`. If there is none, it raises a config error before anything is sent. Only cash-on-delivery orders are sent, with `amount = codAmount`; a prepaid order is refused before sending, because the amount to declare for it is undocumented. Response mapping: `code` → `externalId` and `trackingNumber`, `fee` → `cost`, and `status[/status_return]` → `rawStatus`. A 2xx response with `success: false` is **« à vérifier »** since 2026-10-16 (`senditUnconfirmedCreateRefusal`, `errors.ts`): the official spec documents no `success: false` body for creation (only 200, 250/251/252, 422, 403, 500), so it does not prove that nothing was created; Sendit's own message is shown sanitized. A 2xx response with no readable code, or any unexpected error after the request was sent, is also « à vérifier ».
- **fetchStatus / fetchTracking:** `GET /deliveries/{code}` (the code is URL-encoded). `rawStatus` is `STATUS`, or `STATUS/STATUS_RETURN` when a return state is present, kept verbatim. Tracking events come from `audits`: consecutive duplicates are dropped and events keep the received order. `created_at` goes into `description` verbatim, and `timestamp`/`lastUpdateAt` stay `null` because no timezone is documented. Courier and location are `null`.
- **listCities:** `GET /districts?page=1..last_page`, capped at 200 pages. `pickup-district` is sent when `pickupDistrictId` is configured. When `last_page` is missing, the loop stops once there is no next page.
- **fetchLabel:** `POST /deliveries/getlabels { codesToPrint, printFormat: labelPrintFormat ?? 1 }` → https `fileUrl`. If no https link comes back, it falls back to the parcel's signed https `labelUrl`. The link is returned on demand and never stored. Since 2026-10-16 a `labelUrl` / `fileUrl` is kept only when it is `https:` **on `app.sendit.ma`** (`SENDIT_LABEL_HOSTS`, `src/lib/integrations/delivery/carrier-hosts.ts`; host taken from the spec's `servers` and `signed-files` examples); any other host, an `http:` link, credentials in the URL or a non-default port is dropped. If Sendit serves labels from another host (e.g. a CDN), the label button will find no link — check on the first real label.

Not implemented:
- `CANCEL_SHIPMENT`: `DELETE /deliveries/{code}` is documented only as « Supprimer un colis ». The spec does not say which statuses allow it, or whether it cancels or hard-deletes.
- `PUT` edit: the shared contract has no edit capability.
- `WEBHOOKS`: Sendit documents none.
- `GENERATE_MANIFEST`: not used here.
- Logo: there is no Sendit asset, so the generic fallback icon is used.

## Provisional status mapping — pending review, not approved for live activation

`SENDIT_STATUS_MAPPING_STATUS = "PROVISIONAL_PENDING_OWNER_REVIEW"`. The raw status is always kept.

| Sendit `status` | Label | Local |
|---|---|---|
| PENDING / TO_PREPARE / TO_PICKUP / NEW_DESTINATION | En attente / À préparer / Ramassage en cours / À changer | EN_ATTENTE |
| PICKEDUP / WAREHOUSE / TRANSIT / DISTRIBUTED / DELIVERING / SCHEDULED / POSTPONED / UNREACHABLE | … | EN_TRANSIT |
| DELIVERED | Livré | LIVRE |
| CANCELED / REJECTED | Annulé / Refusé | ECHEC |
| any, with `status_return` = RETURN_STOCK or RETURN_SELLER | — | RETOURNE (takes precedence) |
| unknown | — | `null` (the raw value is kept and no status is guessed) |

## Still open

1. Token lifetime and expiry (undocumented). It is cached for 20 min, with one re-login on 401.
2. Rate limits (none documented) and whether a sandbox or test account exists.
3. Which create fields are required (none are marked required) and which phone formats are accepted (only `06XXXXXXXX` is shown).
4. For prepaid parcels, what `amount` should be. Prepaid orders are refused for now.
5. The allowed `printFormat` values for `getlabels`. The spec's example is 1, which is the default.
6. `DELETE /deliveries/{code}`: which statuses allow it, and whether it is a cancellation or a deletion.
7. Owner review of the status mapping, including which `status_return` values mean « retourné ».
8. What `products` may hold when Sendit stock is not used (free text? length?).
9. In `/districts`, what `ville` means versus `name`; whether `pickup_district_id` is mandatory on create.
10. The order and timezone of `audits` and `last_action_at`.
11. Whether 250/251/252 are real HTTP statuses or codes in the body. Both are handled as definite refusals.
12. **`success` type (check on the first real parcel).** The envelope schema types `success` as a JSON boolean (`senditEnvelopeSchema`, `types.ts`), while the spec's examples show the string `"true"`. If the live API really sends a string, `/login` fails as « Réponse Sendit illisible » (the connection test fails) and every creation becomes « à vérifier ». Nothing is coerced on purpose: confirm the real type, then adjust the schema if needed.
13. Whether a real `success: false` answer to `POST /deliveries` ever means « nothing created ». Until Sendit documents it, it stays « à vérifier ».
14. Label host: confirm that `labelUrl` / `fileUrl` are always on `app.sendit.ma`.

## Live validation checklist (owner, on a real account)

- [ ] « Tester la connexion » with real keys → Connecté.
- [ ] City mapping: the `/districts` catalogue loads, and order cities resolve.
- [ ] One real COD parcel: code, fee and initial status are correct on the Sendit portal.
- [ ] « Étiquette » opens a valid PDF.
- [ ] Status refresh after pickup and after delivery; review the mapping table.
- [ ] Look at the raw `/login` and `POST /deliveries` answers once: is `success` a boolean or the string `"true"`? (See « Still open » 12.)
- [ ] The label link is on `https://app.sendit.ma/…` (see « Still open » 14).
