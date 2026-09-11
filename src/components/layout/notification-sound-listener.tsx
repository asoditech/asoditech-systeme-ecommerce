"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getNotificationSoundSyncAction } from "@/actions/notifications";
import { computeNewNotificationIds, playNotificationSound, unlockAudio } from "@/lib/notification-sound";

/**
 * Mounted exactly once, inside AppShell (src/app/(protected)/layout.tsx),
 * so it survives every client-side navigation between pages that share
 * the protected layout — one polling loop for the whole session, never
 * one per page. Renders nothing; NotificationBell's own UI is untouched.
 *
 * Polls the existing notification inbox (getNotificationSoundSyncAction,
 * the exact same tenant/permission-scoped query the bell's server render
 * already uses) every 25s while the tab is visible, pausing entirely
 * while it's hidden and catching up once immediately when it becomes
 * visible again. The first successful poll only establishes the
 * "already seen" baseline — see docs/adr/0016-notifications.md's
 * addendum — so existing unread notifications never play a sound on
 * load or refresh; only ids that show up in a *later* poll do, batched
 * into a single sound no matter how many arrived since the last tick.
 */
const POLL_INTERVAL_MS = 25_000;

export function NotificationSoundListener() {
  const router = useRouter();
  const seenIdsRef = useRef<Set<string> | null>(null);

  // Unlock the shared <audio> element on the user's first real
  // interaction with the page — required by browser autoplay policy.
  useEffect(() => {
    function unlock() {
      unlockAudio();
    }
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function sync() {
      if (document.visibilityState !== "visible") return;
      let result: Awaited<ReturnType<typeof getNotificationSoundSyncAction>>;
      try {
        result = await getNotificationSoundSyncAction();
      } catch {
        return; // transient network/auth hiccup — next tick retries, nothing to surface
      }
      if (cancelled) return;

      const { isBaseline, newIds } = computeNewNotificationIds(seenIdsRef.current, result.items);
      seenIdsRef.current = new Set(result.items.map((item) => item.id));

      if (!isBaseline && newIds.length > 0) {
        playNotificationSound();
        router.refresh(); // one batch, one sound — the bell's own badge/list catches up here
      }
    }

    function startPolling() {
      if (timer) return; // guards against ever running two loops
      timer = setInterval(sync, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        sync();
        startPolling();
      } else {
        stopPolling();
      }
    }

    sync();
    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [router]);

  return null;
}
