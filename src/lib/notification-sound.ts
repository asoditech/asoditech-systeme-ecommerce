/**
 * Client-side notification sound — a pure UX alert on top of the existing
 * notification inbox (docs/adr/0016-notifications.md). Never creates,
 * mutates, or reads a `Notification` row itself; it only reacts to what
 * NotificationSoundListener already fetched via the existing
 * tenant/permission-scoped query.
 *
 * Split in two halves on purpose:
 *  - `computeNewNotificationIds` is pure (no DOM, no audio) — the part
 *    that decides "is this genuinely new", fully unit-testable.
 *  - everything else touches `window`/`localStorage`/`Audio` and is only
 *    ever called from client-side effects/handlers, never at module
 *    top-level (this file can still be *imported* during SSR of a
 *    "use client" component, so nothing here may run browser APIs eagerly).
 */

const SOUND_PREF_KEY = "asoditech:notifications:sound-enabled";
const LAST_PLAYED_KEY = "asoditech:notifications:last-played-at";
const SOUND_SRC = "/sounds/notification.mp3";
const VOLUME = 0.35;
/** Multi-tab guard window — if another tab played within this long, skip
 * ours. Best-effort coordination via localStorage, not a strict lock;
 * see docs/adr/0016-notifications.md's addendum for why that's enough. */
const MULTI_TAB_GUARD_MS = 4000;

export interface NotificationLike {
  id: string;
}

/**
 * Notification types that represent an order event (new order, delivery
 * failure, return) — the ones an order-confirmation agent actually needs
 * an audible alert for. Everything else (stock, integration/sync errors,
 * support tickets) still shows up in the bell as usual, just silently.
 * Kept as plain strings (not the Prisma `NotificationType` enum) so this
 * file never needs to import server/Prisma code into a client bundle.
 */
const ORDER_NOTIFICATION_TYPES = new Set(["NOUVELLE_COMMANDE", "ECHEC_LIVRAISON", "COMMANDE_RETOURNEE"]);

export function isOrderRelatedNotification(type: string): boolean {
  return ORDER_NOTIFICATION_TYPES.has(type);
}

/**
 * The new-notification detector. `previousIds === null` means "no
 * baseline yet" — the very first successful sync, which must never play
 * a sound no matter how many items it returns (see ADR 0016 addendum).
 * Every later call compares against the previous poll's id set, so:
 *  - the same notification returned again is never "new" twice,
 *  - a lower unread count (marked read elsewhere) is irrelevant — this
 *    never looks at `isRead` or any count, only id membership,
 *  - several genuinely new ids in one poll come back together, so the
 *    caller can play exactly one sound for the whole batch.
 */
export function computeNewNotificationIds(
  previousIds: ReadonlySet<string> | null,
  currentItems: readonly NotificationLike[]
): { isBaseline: boolean; newIds: string[] } {
  if (previousIds === null) {
    return { isBaseline: true, newIds: [] };
  }
  const newIds = currentItems.filter((item) => !previousIds.has(item.id)).map((item) => item.id);
  return { isBaseline: false, newIds };
}

export function isSoundEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(SOUND_PREF_KEY);
    return stored === null ? true : stored === "1";
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, enabled ? "1" : "0");
  } catch {
    // localStorage unavailable (private mode, quota) — the preference
    // just won't persist; sound stays at its in-memory default.
  }
}

let sharedAudio: HTMLAudioElement | null = null;
let unlocked = false;

function getSharedAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!sharedAudio) {
    sharedAudio = new Audio(SOUND_SRC);
    sharedAudio.preload = "auto";
    sharedAudio.volume = VOLUME;
  }
  return sharedAudio;
}

/**
 * Call from a real user interaction (click/keydown/pointerdown) to prime
 * the shared <audio> element past the browser's autoplay restriction.
 * Safe to call repeatedly — a no-op once already unlocked.
 */
export function unlockAudio(): void {
  if (unlocked) return;
  const audio = getSharedAudio();
  if (!audio) return;
  audio.muted = true;
  const playAttempt = audio.play();
  if (playAttempt && typeof playAttempt.then === "function") {
    playAttempt
      .then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
        unlocked = true;
      })
      .catch(() => {
        // Still locked — a later real interaction will retry. Never
        // surfaced to the user, never breaks anything else.
        audio.muted = false;
      });
  } else {
    unlocked = true;
    audio.muted = false;
  }
}

function recentlyPlayedInAnotherTab(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(LAST_PLAYED_KEY);
    if (!raw) return false;
    const last = Number(raw);
    return Number.isFinite(last) && Date.now() - last < MULTI_TAB_GUARD_MS;
  } catch {
    return false;
  }
}

function markPlayedNow(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_PLAYED_KEY, String(Date.now()));
  } catch {
    // Coordination is best-effort — worst case another open tab also
    // plays the same short sound once. Never worth failing over.
  }
}

/**
 * Plays the notification chime at most once, best-effort. Never throws —
 * a blocked/failed play() is caught and swallowed (logged only outside
 * production) so the notification itself always still appears regardless
 * of audio support.
 */
export function playNotificationSound(): void {
  if (!isSoundEnabled()) return;
  if (recentlyPlayedInAnotherTab()) return;

  const audio = getSharedAudio();
  if (!audio) return;

  markPlayedNow();
  try {
    audio.currentTime = 0;
    const playAttempt = audio.play();
    if (playAttempt && typeof playAttempt.catch === "function") {
      playAttempt.catch((error: unknown) => {
        if (process.env.NODE_ENV !== "production") {
          console.debug("[notification-sound] playback blocked:", error);
        }
      });
    }
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[notification-sound] playback failed:", error);
    }
  }
}
