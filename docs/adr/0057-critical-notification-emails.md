# ADR 0057 — Critical notification emails

## Status
Accepted (2026-10-02). No schema change, no migration, no new environment
variable. Builds on ADR 0016 (in-app notifications), 0056 (location-scoped
notifications), 0027 (Resend transactional email).

## Decision
Four critical events also send an email, immediately, to the same users who
receive the in-app notification:

| Event | In-app type | Trigger | Link |
|---|---|---|---|
| Out of stock | `RUPTURE_STOCK` | `checkAndNotifyLowStock` (stock item at 0) | `/stock` |
| Delivery failure | `ECHEC_LIVRAISON` | `notifyShipmentFailed` | `/livraison` |
| Integration error | `ERREUR_INTEGRATION` | `notifyConnectionError` (store integration or carrier) | `/integrations` or `/livraison` |
| Plan limit reached | `USAGE_LIMIT_ALERT` at 100 % only | `checkAndNotifyUsageThreshold` | `/parametres/abonnement` |

All other events stay in-app only:
- new order;
- low stock;
- payment problem;
- workflow mismatch;
- order stock shortage;
- usage at 80/90 %;
- returns;
- sync runs (`ECHEC_SYNCHRONISATION`);
- support tickets.

### Mechanism
`notify()` takes an optional `email` (built by `src/lib/notification-email.ts`).
- **Recipients:** exactly the users `notify()` already selected. That means
  the same tenant, active users, the effective permission and, for a
  location-bound event, the ADR 0056 location rule (OWNER/ADMIN global).
  The email goes to the user's account email; never a customer address.
- **Idempotency:** the notification insert is now
  `createManyAndReturn({ skipDuplicates: true })`, which returns only the
  rows this call actually inserted. Only those users are emailed. The
  existing `@@unique([userId, dedupeKey])` is therefore also the email
  idempotency key: a retried, concurrent or reprocessed event inserts no
  row and sends no email. An email requires a `dedupeKey`.
- **Transport:** `sendNotificationEmails` in `src/lib/email.ts` reuses the
  existing Resend client, `RESEND_API_KEY`, `EMAIL_FROM` and `APP_URL`. It
  sends one Resend **batch** call (each message addressed to one person),
  so a fan-out is one request rather than a burst against the rate limit.
  It never throws: a failure is logged without the address or the body. The
  business transaction is committed before `notify()` runs, and the in-app
  notification exists either way.

## Consequences / limitations
- Out-of-stock keeps the in-app daily bucket. A product that stays at zero
  and is touched again on a later day emails again that day, at most once
  per item, location and day.
- A user who dismisses an in-app notification deletes its row. If the same
  event is reprocessed inside its bucket (same item the same day, same
  shipment), that user is notified and emailed again. This is the existing
  in-app behaviour; emails follow it.
- Stock recovering also deletes the alert (`resolveNotifications`), so a
  new stock-out the same day is a new event and emails again.
- There is no send log, no retry and no preference: a failed send is only
  logged. Production must have a verified Resend sending domain. Until
  then, Resend test mode delivers only to the account owner.
