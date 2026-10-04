# ADR 0059 — Platform announcement bar

## Status
**Accepted — implemented (2026-10-04), migration not yet applied anywhere.**
One additive migration: `20261004120000_platform_announcements` (new enum
`AnnouncementType`, new table `platform_announcements`).

## Decision
- **Platform-level, not tenant data.** `PlatformAnnouncement` has no
  `tenantId`, like `Plan`. The tenant extension therefore doesn't scope it,
  and it has no RLS policy: every tenant reads the same broadcast. It is not
  a `BusinessSettings` field. The tenant support contact settings are
  unchanged.
- **Writes: platform admins only.** `src/actions/announcements.ts`:
  - Every action starts with `requirePlatformAdminForAction`, which checks
    the `isPlatformAdmin` flag and an unlocked Platform Access Key session.
    This runs before any input is read or the table is touched.
  - No payload carries a tenant id.
  - Every mutation is audited: `announcement.created`, `.updated`,
    `.published`, `.unpublished`, `.deleted`.
- **Management** lives in the existing `/platform` area:
  - page `/platform/annonces`, with an « Annonces » nav entry;
  - list with status and dates;
  - create/edit dialog;
  - publish/disable and delete.
- **Fields:**
  - message, at most 280 characters;
  - type: `INFO`, `MAINTENANCE` or `NEW_FEATURE`;
  - `isPublished`;
  - optional `startsAt` / `endsAt`. The browser converts `datetime-local`
    to an ISO instant, and the server accepts only ISO instants;
  - optional action label (40 characters) plus URL, given together.
- **URL safety** (`safeAnnouncementUrl`, checked on write and again on
  render):
  - allowed: an in-app path starting with `/` (not `//` or `/\`), or an
    `https://` URL without credentials;
  - rejected: anything else, including `javascript:`, `data:`, `http:`,
    relative paths and whitespace or control characters.
- **Display:**
  - The protected `AppShell` renders `AnnouncementBar` directly below the
    sticky header, in normal document flow. It never touches the global
    orange `TopProgressBar` (fixed, root layout).
  - Live means published and inside `[startsAt, endsAt)`.
  - Exactly one announcement is shown. The order is: type priority
    (MAINTENANCE > NEW_FEATURE > INFO), then the most recent
    (`startsAt ?? createdAt`), then `id`. There is no carousel.
  - With no live announcement, nothing is rendered.
  - A read error also renders no bar (fail-soft), so a missing migration
    can't break every page.
- **Dismissal is per browser:**
  - The cookie `announcement-dismissed` holds up to 20 keys of the form
    `id.updatedAtMs`. This is the same convention as `sidebar-collapsed`:
    written by the client, read on the server, so the bar doesn't flash.
  - The announcement row is never written. Editing an announcement shows
    it again.
- **« Contacter le support »** dispatches `asoditech:open-support`
  (`src/lib/support/open-support.ts`). The existing `SupportWidget` listens
  for it and opens its own panel. There is no second support flow.

## Rollout
- `vercel-build` = `prisma migrate deploy && next build`. Any build that
  Vercel runs against an environment's database applies this migration
  automatically: production on a deploy of `main`, and Preview on a branch
  push, with Preview's own database.
- The runtime role gets DML on the new table through the existing
  `ALTER DEFAULT PRIVILEGES` (`scripts/provision-production-role.sql`), as
  long as migrations keep running as the same migration role. Nothing needs
  re-provisioning.
- Local dev and test databases need `prisma migrate deploy` before the
  feature can be exercised end to end. The automated tests stub only this
  table's delegate.
