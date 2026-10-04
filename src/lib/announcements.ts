/**
 * Platform announcement bar (docs/adr/0059) — pure, client-safe rules shared
 * by the platform-admin editor, the server query and the bar itself:
 * URL safety, the live window, the deterministic choice between several live
 * announcements, and the per-browser dismissal cookie.
 */

export const ANNOUNCEMENT_TYPES = ["INFO", "MAINTENANCE", "NEW_FEATURE"] as const;
export type AnnouncementTypeValue = (typeof ANNOUNCEMENT_TYPES)[number];

export const ANNOUNCEMENT_TYPE_LABELS: Record<AnnouncementTypeValue, string> = {
  INFO: "Information",
  MAINTENANCE: "Maintenance",
  NEW_FEATURE: "Nouveauté",
};

export const ANNOUNCEMENT_MESSAGE_MAX = 280;
export const ANNOUNCEMENT_ACTION_LABEL_MAX = 40;
export const ANNOUNCEMENT_ACTION_URL_MAX = 500;

/**
 * The only call-to-action targets accepted: an in-app absolute path
 * ("/rapports", never "//host" or "/\host", which browsers treat as another
 * origin) or an https:// URL with a host and no embedded credentials.
 * Everything else (javascript:, data:, http:, mailto:, relative paths,
 * control characters…) → null.
 */
export function safeAnnouncementUrl(raw: string | null | undefined): string | null {
  const url = (raw ?? "").trim();
  if (!url || url.length > ANNOUNCEMENT_ACTION_URL_MAX) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(url)) return null;
  if (url.startsWith("/")) {
    if (url.startsWith("//") || url.startsWith("/\\")) return null;
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.toString();
}

export function isExternalAnnouncementUrl(url: string): boolean {
  return !url.startsWith("/");
}

interface Schedulable {
  isPublished: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** Published AND inside the optional [startsAt, endsAt) window. */
export function isAnnouncementLive(a: Schedulable, now: Date): boolean {
  if (!a.isPublished) return false;
  if (a.startsAt && a.startsAt.getTime() > now.getTime()) return false;
  if (a.endsAt && a.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

export type AnnouncementStatus = "DRAFT" | "SCHEDULED" | "LIVE" | "EXPIRED";

export const ANNOUNCEMENT_STATUS_LABELS: Record<AnnouncementStatus, string> = {
  DRAFT: "Désactivée",
  SCHEDULED: "Programmée",
  LIVE: "En ligne",
  EXPIRED: "Expirée",
};

export function announcementStatus(a: Schedulable, now: Date): AnnouncementStatus {
  if (!a.isPublished) return "DRAFT";
  if (a.endsAt && a.endsAt.getTime() <= now.getTime()) return "EXPIRED";
  if (a.startsAt && a.startsAt.getTime() > now.getTime()) return "SCHEDULED";
  return "LIVE";
}

/** Maintenance first (it affects everyone's work), then new features, then information. */
const TYPE_PRIORITY: Record<AnnouncementTypeValue, number> = { MAINTENANCE: 0, NEW_FEATURE: 1, INFO: 2 };

interface Pickable extends Schedulable {
  id: string;
  type: AnnouncementTypeValue;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Dismissal key: id + last edit time, so editing an announcement shows it
 * again to browsers that had dismissed the previous wording.
 */
export function announcementDismissKey(a: { id: string; updatedAt: Date }): string {
  return `${a.id}.${a.updatedAt.getTime()}`;
}

/**
 * The ONE announcement to show: live, not dismissed in this browser, then
 * highest type priority, then the most recent (startsAt, else createdAt),
 * then id — fully deterministic, no carousel. null when nothing applies.
 */
export function pickAnnouncement<T extends Pickable>(rows: readonly T[], now: Date, dismissed: ReadonlySet<string> = new Set()): T | null {
  const live = rows.filter((a) => isAnnouncementLive(a, now) && !dismissed.has(announcementDismissKey(a)));
  live.sort(
    (a, b) =>
      TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type] ||
      (b.startsAt ?? b.createdAt).getTime() - (a.startsAt ?? a.createdAt).getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return live[0] ?? null;
}

/**
 * Per-browser dismissal (no database row: dismissing never changes the
 * announcement for anyone else). Same convention as the sidebar-collapsed
 * cookie: written client-side, read server-side so the first paint already
 * omits a dismissed bar (no flash, no empty space).
 */
export const ANNOUNCEMENT_DISMISS_COOKIE = "announcement-dismissed";
export const ANNOUNCEMENT_DISMISS_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;
const MAX_DISMISSED = 20;
const KEY_RE = /^[a-z0-9]{1,40}\.\d{1,15}$/;

export function parseDismissedCookie(value: string | null | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split("~")
      .map((k) => k.trim())
      .filter((k) => KEY_RE.test(k))
      .slice(-MAX_DISMISSED)
  );
}

/** The new cookie value after dismissing `key` (most recent kept, bounded size). */
export function addDismissedKey(value: string | null | undefined, key: string): string {
  if (!KEY_RE.test(key)) return [...parseDismissedCookie(value)].join("~");
  const keys = [...parseDismissedCookie(value)].filter((k) => k !== key);
  keys.push(key);
  return keys.slice(-MAX_DISMISSED).join("~");
}

/**
 * `<input type="datetime-local">` ↔ ISO instant, in the BROWSER's time zone
 * (the editor runs client-side): the platform admin types local wall-clock
 * time and the server only ever receives an unambiguous instant.
 */
export function localInputToIso(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return "";
  const d = new Date(value); // no offset → parsed as local time
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
