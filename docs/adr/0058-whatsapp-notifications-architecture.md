# ADR 0058 — WhatsApp critical notifications

## Status
**Accepted — V1 implemented (2026-10-02).** One migration
(`20261002120000_user_whatsapp_notifications`, additive nullable `users`
columns). The original proposal follows the V1 section and is kept for
context. Where they differ, the V1 section wins.

## V1 as built (owner decisions final)
- **Sender.**
  - One central ASODITECH WhatsApp Business number, configured with
    `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
    `WHATSAPP_GRAPH_API_VERSION` (default `v23.0`).
  - There are no per-tenant credentials. The tenant's
    `Integration(WHATSAPP)` row is only the switch: `CONNECTE` = on.
  - « Activer / Tester la connexion » reads the sending number from Meta
    (`GET /{phone-number-id}`) and never sends a message. On failure the row
    goes to `ERREUR` and the existing `notifyConnectionError` fires.
  - « Désactiver » is the existing `disconnectIntegrationAction`.
- **Provider.** `src/lib/whatsapp/`:
  - `client.ts`: `sendTemplate(to, templateName, language, parameters)` and
    `checkWhatsAppSender`, using plain `fetch`, no SDK. It never throws, and
    sends nothing when unconfigured or under `NODE_ENV=test`. Logs carry the
    template name and Meta's error code/type, never the number, the body or
    the token.
  - `templates.ts`: the template builders.
  - `phone.ts`: reuses `toMoroccanWhatsAppDigits` and outputs E.164 digits.
  - `verification.ts`: the code helpers.
  - `dispatch.ts`: the recipient narrowing and the daily claim.
- **Events.**

  | Event | Template | Parameters |
  |---|---|---|
  | Out of stock | `asoditech_stock_out` | product, location |
  | Delivery failure | `asoditech_delivery_failure_summary` | count, carriers |
  | Integration down | `asoditech_integration_down` | integration name |

  Nothing else uses WhatsApp, and there is no daily summary.
- **Recipients.** The users `notify()` selected and newly inserted a row
  for (tenant, active, effective permission, ADR 0056 location scope), AND:
  - the tenant switch is on and the central sender is configured;
  - the user has a verified number (`whatsappVerifiedAt`);
  - the user explicitly opted in (`whatsappOptInAt`).

  WhatsApp only narrows the in-app set; it never widens it.
- **Idempotency.** There is no send log. A message is sent only for an
  in-app row newly inserted by this call, via
  `createManyAndReturn({ skipDuplicates })` and the existing
  `@@unique([userId, dedupeKey])`. There are no retries.
- **Delivery failures.**
  - In-app and email stay one per shipment.
  - WhatsApp is one summary per recipient per batch, and
    « Rafraîchir les statuts » now notifies its failures after its loop, as
    one batch.
  - It is capped at one per recipient per UTC day by an atomic conditional
    `UPDATE` on `User.whatsappDeliveryFailureNotifiedAt`. The per-shipment
    dedupe key cannot express "per recipient per day", and a send log was
    ruled out.
- **Number ownership.**
  - The user's own page, Paramètres → Notifications (`/parametres/notifications`,
    see "Final responsibility split" below): save number → request a
    6-digit code (`asoditech_verification_code`, Meta "Authentication"
    template) → type it → opt in or out.
  - Only an HMAC of the code is stored (`User.whatsappVerification`), bound
    to the user and the number.
  - Limits: the code expires after 10 min, with 5 attempts, a 60 s resend
    cooldown and 5 codes per 24 h.
  - Wrong guesses are counted atomically (optimistic on `updatedAt`).
  - Changing the number resets verification and opt-in.
  - The actions take no user id, so nobody (admin included) can change or
    opt in another user.
  - Requesting a code requires the tenant switch to be on.
- **Migration.** Five nullable `users` columns:
  - `whatsappPhone`
  - `whatsappVerifiedAt`
  - `whatsappOptInAt`
  - `whatsappVerification` (JSONB)
  - `whatsappDeliveryFailureNotifiedAt`

  There is no backfill, so every existing user stays opted out.
- **Before production sending works**, these four templates must exist and
  be approved (language `fr`) in the central account. Nothing creates them:
  - `asoditech_stock_out`
  - `asoditech_delivery_failure_summary`
  - `asoditech_integration_down`
  - `asoditech_verification_code`

## Final responsibility split (notifications area closed, 2026-10-02)
One source of truth per concern:

| Concern | Where | Who |
|---|---|---|
| **A. Channel / provider config** — Resend sender, central Meta sender (env vars, never in the UI); tenant WhatsApp on/off + « Tester la connexion » | `/integrations`: « WhatsApp Business — Configuration du canal d'envoi »; « Email » (read-only status) | `integrations.view` / `integrations.manage` |
| **B. The user's own communication settings** — in-app sound (this browser), email (informational: address + availability), WhatsApp number / verification / opt-in, and which alerts reach them on which channel | Paramètres → Notifications (`/parametres/notifications`); links from the user menu « Mes notifications », `/notifications` « Préférences », and both integration cards | every signed-in user; only ever the session user (`src/actions/whatsapp.ts` takes no user id) |
| **C. Notification engine** — who is notified of what | `src/lib/notifications.ts` (`notify()` + helpers), `src/lib/email.ts`, `src/lib/whatsapp/dispatch.ts` | server-side only; the settings page is a read-only mirror (`src/lib/notification-settings.ts` `ALERT_RULES`) |

- There are no fake switches. The only toggles are:
  - the WhatsApp opt-in, enforced at send time;
  - the notification sound, which is client-only.
- Email alerts have no per-user opt-out. The email card is informational.
  Adding one would need a persisted preference, and is an owner decision.
- `/compte` was removed before release: there is a single WhatsApp
  settings UI.

# Original proposal

## Scope
WhatsApp is a third delivery channel for the same critical events as ADR 0057:
- out of stock;
- delivery failure;
- integration down;
- optionally, one daily summary.

It never covers:
- new orders, low stock, payment problems, workflow mismatch or order
  stock shortage;
- returns, delivered orders or support tickets;
- usage at 80/90 %.

The recipients are the tenant's own staff, never a customer or buyer.

## 1. Provider abstraction
One small module, `src/lib/whatsapp/`, with no SDK. It calls the Graph API
with `fetch`, like the WooCommerce and Shopify clients.

```ts
interface WhatsAppProvider {
  sendTemplate(input: {
    to: string;            // E.164 digits, no "+"
    templateName: string;  // e.g. "asoditech_stock_out"
    language: "fr";        // later "ar"
    parameters: string[];  // body {{1}}..{{n}}, in order
  }): Promise<{ ok: true; messageId: string } | { ok: false; retryable: boolean; error: string }>;
}
```

- **Implementations:**
  - a Cloud API implementation, `POST /{phone-number-id}/messages`;
  - a fake for tests, in the style of `tests/helpers/fake-*`.
- **Log-only mode:** when unconfigured, or when `NODE_ENV === "test"`, the
  provider logs and does not send. This is the same guard as `src/lib/email.ts`.

## 2. Integration model
The existing model fits as is:
- `IntegrationProvider.WHATSAPP` already exists, and `/integrations` already
  lists it as a planned provider;
- `Integration` is unique per `(tenantId, provider)`, scoped by tenant and
  protected by row-level security;
- credentials go in `credentialsEncrypted`, using the AES-256-GCM
  `encryptSecret`/`decryptSecret` helpers in `src/lib/crypto.ts`;
- non-secret identifiers go in `config` (JSON).

Two ways to own the sender — **this is an owner decision**:

**A. Platform sender (recommended for v1).** ASODITECH owns one WhatsApp
Business Account and number, and sends to every tenant's opted-in staff.
- Credentials live in environment variables, not in the database.
- Templates are approved once, under the ASODITECH name.
- The per-tenant `Integration(WHATSAPP)` row only says whether the tenant
  enabled the feature:
  - `status` is `CONNECTE` (on) or `DECONNECTE` (off);
  - `config` holds `{ events: [...] }`;
  - `credentialsEncrypted` stays null.
- No tenant onboarding with Meta is needed. ASODITECH pays Meta's
  per-message (utility template) fees.

**B. Tenant-owned sender.** Each tenant connects its own WhatsApp Business
Account.
- `config` holds `{ wabaId, phoneNumberId }`.
- `credentialsEncrypted` holds `{ accessToken, appSecret }`.
- Each tenant needs its own template approvals and a Meta business
  verification.
- Much heavier onboarding; only worth it if tenants must send from their
  own number.

### Meta identifiers
- WhatsApp Business Account (WABA) id.
- Phone number id.
- A permanent system-user access token, scoped to `whatsapp_business_messaging`.
- The app secret, used to check `X-Hub-Signature-256` on future delivery-status
  webhooks.
- The webhook verify token, only if status callbacks are added.
- The Graph API version.

### Validation and enable/disable
- **"Tester la connexion":**
  - calls `GET /{phone-number-id}?fields=display_phone_number,verified_name,quality_rating`;
  - on failure: `status=ERREUR` with `lastError` set, plus the existing
    `notifyConnectionError`, so in-app and email alerts follow the same path
    as the other integrations;
  - on success: `status=CONNECTE` and `lastConnectionCheckAt` set.
- **Disabling** sets `status=DECONNECTE`. Senders check
  `status === "CONNECTE"` before sending.

## 3. Recipient model — needs a migration
`User` has `email` and no phone number. The customer `whatsapp` field and
`BusinessSettings.supportWhatsapp` must never be used. The smallest
addition is two nullable columns:

```prisma
model User {
  // …
  /// E.164 digits, set only by the user themself (docs/adr/0058).
  whatsappPhone     String?
  /// Explicit opt-in timestamp; null = never message this user on WhatsApp.
  whatsappOptInAt   DateTime?
}
```

```sql
ALTER TABLE "users" ADD COLUMN "whatsappPhone" TEXT, ADD COLUMN "whatsappOptInAt" TIMESTAMP(3);
```

- The change is additive and nullable: no backfill, existing users and code
  are unaffected, and every existing user stays opted out.
- Row-level security is unchanged, because `users` is already tenant-scoped.
- Opting out sets `whatsappOptInAt = null`. The number may be kept.
- Only the user can set their own number and opt-in; an admin cannot set
  them for someone else. A one-time test or confirmation message is
  recommended; see owner decision 3.

**Recipient rule:**
- exactly the users `notify()` selects:
  - same tenant;
  - active;
  - the effective permission;
  - for location-bound events, the ADR 0056 location rule, with
    OWNER/ADMIN global;
- AND `whatsappOptInAt != null`;
- AND a valid `whatsappPhone` (reuse `normalizeWhatsappNumber` from
  `src/lib/support/contact.ts`);
- AND the tenant's WhatsApp integration is `CONNECTE`.

## 4. Templates
Meta-approved, category "Utility", French. All are short; the parameters are
`{{n}}`. Every message ends with "Ouvrez ASODITECH pour plus de détails."
(or the integration link), and none contains an internal id, a price, a
cost or customer data.

| Name | Body |
|---|---|
| `asoditech_stock_out` | « Rupture de stock : {{1}} est épuisé à {{2}}. » |
| `asoditech_delivery_failure_summary` | « {{1}} livraison(s) en échec nécessitent votre attention ({{2}}). » |
| `asoditech_integration_down` | « Erreur d'intégration : la connexion à {{1}} a échoué. Vérifiez la configuration. » |
| `asoditech_daily_summary` (optional) | « Résumé du {{1}} : {{2}} rupture(s), {{3}} échec(s) de livraison, {{4}} alerte(s) d'intégration. » |

## 5. Idempotency
- **Without a new table (v1 possible):** send only to users whose
  notification row was newly inserted, as for email in ADR 0057, using the
  existing `@@unique([userId, dedupeKey])`. This prevents duplicates on
  retries and concurrent runs.
- **What that cannot do:**
  - retry a failed send;
  - prove what was sent;
  - survive a user dismissing the notification, which deletes the row;
  - batch failures (see below).

For a guaranteed "same tenant + user + channel + event key, sent once", add a
small table **in the implementation phase**:

```prisma
model NotificationDelivery {
  id                String   @id @default(cuid())
  tenantId          String   @default("default")
  userId            String
  channel           String   // "WHATSAPP" (later "EMAIL")
  eventKey          String   // the notify() dedupeKey, or "daily_summary:<YYYY-MM-DD>"
  status            String   // PENDING | SENT | FAILED
  attempts          Int      @default(0)
  providerMessageId String?
  lastError         String?  // provider error code only — no phone, no body
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@unique([tenantId, userId, channel, eventKey])
  @@index([tenantId, status])
}
```

It would be tenant-scoped and protected by row-level security. Inserting
first with `skipDuplicates` claims the send; the insert winner sends.

## 6. Batching, daily summary and retry
- **Today:** there is no cron or queue anywhere. `vercel.json` only sets the
  region. All alerts are request-driven.
- **Delivery-failure batching:** `refreshShipmentStatusesAction` (and the
  per-shipment status actions) call `notifyShipmentFailed` once per shipment.
  For WhatsApp:
  - gather the failures of one run and send one summary per recipient at the
    end of the run;
  - and/or cap delivery-failure WhatsApp messages at one per user per day,
    with event key `delivery_failure:<YYYY-MM-DD>`.
  - In-app and email stay per shipment.
- **Daily summary and retries:** one Vercel Cron, added to `vercel.json`
  under `crons`.
  - It calls `GET /api/cron/notifications`, guarded by
    `Authorization: Bearer ${CRON_SECRET}`.
  - It runs once a day, which the Hobby plan also allows.
  - It loops over tenants that have a `CONNECTE` WhatsApp integration and
    runs each tenant inside `runWithTenant(tenantId, "cron:whatsapp", …)`.
  - In each tenant it:
    1. sends the daily summary;
    2. retries `FAILED` deliveries with `attempts < 3` that are less than
       24 h old.
  - No queue service is needed.

## 7. Security checklist for the implementation
- **Tenant and access:** sending runs inside `notify()`, which is already
  tenant-scoped and already filters on active status, effective permissions
  and `UserLocation`. The cron must enter each tenant explicitly
  (`runWithTenant`); it never uses `prismaBase` for per-tenant reads.
- **Opt-in** is checked at send time, not stored on the event.
- **Credentials** are never returned to the client or logged:
  - option A: environment variables only;
  - option B: `encryptSecret` + `credentialsEncrypted`.
- **Logs** hold the template name, user id and the provider's error code —
  never the phone number or the message body. The test suite uses the fake
  provider, and the provider is forced to log-only mode under test.

## 8. Future configuration (option A)
| Variable | Purpose |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | System-user token (secret) |
| `WHATSAPP_PHONE_NUMBER_ID` | Sending number |
| `WHATSAPP_WABA_ID` | Template management and checks |
| `WHATSAPP_APP_SECRET` | Webhook signature (secret); only with status callbacks |
| `WHATSAPP_GRAPH_VERSION` | e.g. `v21.0` |
| `CRON_SECRET` | Vercel Cron auth (secret); only with the daily summary or retries |

Option B replaces the first four with per-tenant `Integration` fields.

## 9. Files touched in the implementation phase
- `prisma/schema.prisma` and one new migration: the `User` columns, plus
  optionally `NotificationDelivery`.
- `src/lib/env.ts`: the variables above, all optional.
- `src/lib/whatsapp/{provider,cloud-api,templates}.ts` (new).
- `src/lib/notifications.ts`: an optional `whatsapp` on `NotifyInput`, set by
  the same three helpers that set `email`.
- `src/actions/delivery.ts`: run-level failure batching in
  `refreshShipmentStatusesAction`.
- Settings:
  - `src/actions/integrations` / the WhatsApp settings card: enable/disable
    and "Tester la connexion";
  - the user's own profile action and form: number plus opt-in.
- `src/app/api/cron/notifications/route.ts` and `vercel.json` `crons`: only
  with the daily summary or retries.
- Tests: the fake provider, recipient filtering (opt-in, number, location,
  tenant), idempotency, and a provider failure that does not break the
  action.
