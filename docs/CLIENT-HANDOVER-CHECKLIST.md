# Client Handover Checklist

Use this at the end of an onboarding (Dedicated model) or whenever
ownership/responsibility for a client's deployment changes hands. Pairs
with `docs/CLIENT-DEPLOYMENT-RUNBOOK.md` (setup) and
`docs/SHARED-VS-DEDICATED.md` (which ownership questions even apply to a
Shared-SaaS tenant vs. a Dedicated deployment).

Copy this file's checklist per client into your own tracking (a ticket, a
shared doc) — this file itself stays a template, not a log of any one
client's handover.

## 0. Which model is this client on?

- [ ] Confirm: **Shared SaaS** (a `Tenant` row on the shared deployment)
      or **Dedicated** (its own Vercel + Supabase project) —
      `docs/SHARED-VS-DEDICATED.md`. Several sections below only apply to
      Dedicated.

## 1. Domain

- [ ] (Dedicated only) Domain registrar account access documented — see
      "Who owns the domain" below.
- [ ] Domain added to the Vercel project (Project → Settings → Domains)
      and shows "Valid Configuration."
- [ ] DNS records (A/CNAME per Vercel's instructions) are in the
      **client's own** DNS provider account, not a personal/agency
      account that could be lost or revoked.
- [ ] `APP_URL` environment variable matches the final domain exactly
      (`https://`, no trailing slash) — see the runbook §2.
- [ ] SSL certificate issued and auto-renewing (Vercel manages this
      automatically once DNS validates — confirm the padlock in a
      browser).

## 2. Admin account

- [ ] The client's real OWNER account exists (created via
      `prisma/seed.ts` for a Dedicated deployment's first tenant, or via
      an `/platform` → invitation for a Shared-SaaS tenant — runbook §8).
- [ ] The client has successfully logged in themselves at least once,
      from their own device, with their own credentials.
- [ ] The seed script's default/local password (`change-me-immediately`)
      is confirmed **not** in use anywhere reachable — `prisma/seed.ts`
      already refuses to run with it when `NODE_ENV=production` and no
      `SEED_OWNER_PASSWORD` is set, but re-confirm at handover time.
- [ ] Every internal/agency account used during setup (temporary access —
      see "Credentials that must never be shared" below) has been removed
      or its password rotated.
- [ ] The client understands invitation-based user provisioning: new
      teammates are added via Utilisateurs → inviter, not by
      you — `createUserAction` does not exist in this codebase (removed in
      ADR 0027); every account is created by accepting an emailed
      invitation link.

## 3. Documentation

- [ ] The client (or their designated technical contact) has been given:
  - [ ] `docs/CLIENT-DEPLOYMENT-RUNBOOK.md` (or a client-appropriate
        excerpt) if they will ever need to redeploy/reconfigure
        themselves.
  - [ ] The in-app Documentation/Demo Center (`/documentation`) —
        already shipped, requires no separate handoff artifact, covers
        day-to-day product usage per role (`docs/CONTRIBUTING.md`).
- [ ] Access to `docs/adr/*.md` is available if the client's own
      technical staff will maintain this codebase going forward (explain
      that these are engineering decision records, not user
      documentation).

## 4. Support procedure

- [ ] `BusinessSettings.supportName` / `supportWhatsapp` / `supportPhone`
      / `supportEmail` / `supportHours` are filled in (Réglages →
      Entreprise) — these drive the in-app floating "Centre d'aide"
      widget's contact section. Leaving them blank simply hides that
      contact method; confirm this is the intended state, not an
      oversight.
- [ ] The client knows who to contact (you, or your support channel) for
      issues the in-app AI quick-answers / help center can't resolve, and
      what response-time expectation applies (this is a business
      agreement — nothing in the codebase enforces an SLA).
- [ ] Support-ticket forwarding (`sendSupportTicketEmail`,
      `src/lib/email.ts`) is confirmed working end-to-end if
      `RESEND_API_KEY`/`EMAIL_FROM` are configured — send one test report
      from the widget and confirm it arrives.

## 5. Backup procedure

- [ ] `BACKUP_ENCRYPTION_KEY` was generated and a copy stored **outside
      the database** (password manager / client's own secrets vault) —
      see the runbook's environment-variables section for why this is
      unrecoverable if lost.
- [ ] At least one manual backup has been taken successfully from
      Réglages → Sauvegarde ("Sauvegarder maintenant") and downloaded.
- [ ] If the client wants an off-platform copy: Google Drive backup
      destination connected (`docs/adr/0034` Phase 2) and at least one
      push-to-Drive verified.
- [ ] The client understands: **there is no scheduled/automatic backup**
      in this codebase today (Phase 3 of `docs/adr/0034`, not built) —
      backups are a manual action, "Sauvegarder maintenant" or "Push to
      Drive," until that phase exists. Set expectations accordingly, or
      establish an external reminder/cron process if the client needs
      recurring backups now.
- [ ] Infrastructure-level backups are also in place independently
      (Supabase's own automatic database backups) — these protect against
      catastrophic database loss but are **not** tenant-scoped/portable
      and are operator-only; explain the distinction from the `.asb`
      module if the client asks.

## 6. Recovery procedure

- [ ] A test restore has been performed at least once (ideally in a
      throwaway/staging tenant, not production) to confirm the client's
      backup file is actually restorable, not just downloadable.
- [ ] The client understands the restore safety model: every restore
      first takes an automatic `PRE_RESTORE_SNAPSHOT` (7-day TTL,
      downloadable) before touching any data, and a restore that fails
      any consistency check rolls back entirely — nothing is left
      half-applied.
- [ ] The client understands that **every integration must be
      reconnected after a restore** — `Integration`/`ShippingProvider`/
      `GoogleDriveConnection` credentials are stripped from every backup
      package by design (never stored in a portable file) and come back
      disconnected.
- [ ] Who to contact for a production incident requiring a restore is
      documented (you, or the client's own technical staff, per their
      chosen support procedure above).

## 7. Billing / hosting ownership

- [ ] It is explicitly agreed and documented **in writing** (not just
      assumed) who pays for:
  - [ ] The Vercel plan/usage (Pro tier is typically required for a
        production custom domain + team access).
  - [ ] The Supabase project's plan/usage.
  - [ ] The domain registration/renewal.
  - [ ] Resend's email-sending plan (if configured).
  - [ ] Google Cloud (only relevant if Drive backup is used — Drive API
        calls are free at this app's scale, but the OAuth consent
        screen's verification status matters, see the runbook's Google
        Drive troubleshooting).
- [ ] The client knows this codebase implements **no subscription
      plans, usage limits, or billing states of its own** — see the
      runbook's §15 (Business/Platform Readiness). Any commercial
      arrangement with the client is handled entirely outside this
      software, today.

## 8. Ownership — who holds each account

Fill in and keep with the client's records (not in this repo):

| System | Account holder | Notes |
| --- | --- | --- |
| Vercel project | ☐ Client's own account &nbsp; ☐ Your/agency account (temporary) | Recommended: client's own Vercel account/team, you added as a Member — see runbook §1 for the reasoning. |
| Supabase project | ☐ Client's own account &nbsp; ☐ Your/agency account (temporary) | Same recommendation as Vercel. |
| Domain registrar | ☐ Client's own account | Never register a client's production domain under your own personal/agency account without an explicit, written agreement on transfer terms. |
| Resend account (email) | ☐ Client's own account &nbsp; ☐ Shared/your account | If shared across multiple clients (Shared-SaaS model), document this explicitly — see `docs/SHARED-VS-DEDICATED.md`'s "what is genuinely shared" table. |
| Google Cloud project (OAuth client for Drive backup) | ☐ Client's own project &nbsp; ☐ Your/agency project | The OAuth *client* is deployment-wide; each tenant's own Google Drive account (where backups land) is always the tenant's own, regardless of who owns the OAuth client. |
| WooCommerce / Shopify / OzonExpress / Aramex accounts | Always the client's own — this app only stores credentials the client provides, never creates accounts on these platforms | N/A |

## 9. Credentials that must never be shared with you (post-handover)

Once handover is complete, you should **not** retain standing access to:

- The client's Vercel account password / the client's removal of your
  Member access if it was only needed for setup.
- The client's Supabase account password.
- The client's domain registrar login.
- `AUTH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY` —
  once set and verified working, there is no operational reason for you
  to keep a personal copy after handover unless you remain the deployment
  operator by agreement.
- Any of the client's own external integration credentials (WooCommerce
  keys, Shopify tokens, carrier API keys, Google account) beyond what was
  needed to configure them together during onboarding.

If you remain the ongoing operator (a support/maintenance agreement),
document that explicitly — it changes several rows in the ownership table
above and should be a deliberate, written choice, not a default left over
from setup.
