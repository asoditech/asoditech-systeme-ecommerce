"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Info, LifeBuoy, Sparkles, Wrench, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ANNOUNCEMENT_DISMISS_COOKIE,
  ANNOUNCEMENT_DISMISS_MAX_AGE_SECONDS,
  ANNOUNCEMENT_TYPE_LABELS,
  addDismissedKey,
  isExternalAnnouncementUrl,
  safeAnnouncementUrl,
} from "@/lib/announcements";
import { openSupportWidget } from "@/lib/support/open-support";
import type { ActiveAnnouncement } from "@/lib/queries/announcements";

// Solid top-bar colours per type (the same in light AND dark mode): a system
// announcement, not page text. Text is always bold white, so each background
// is dark enough for white (maintenance uses a deeper amber than before).
const TYPE_STYLE = {
  INFO: { icon: Info, className: "bg-sky-600 text-white dark:bg-sky-700", iconClass: "text-white" },
  MAINTENANCE: { icon: Wrench, className: "bg-amber-700 text-white", iconClass: "text-white" },
  NEW_FEATURE: { icon: Sparkles, className: "bg-primary text-white", iconClass: "text-white" },
} as const;

function readCookie(name: string): string | null {
  try {
    const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
  } catch {
    return null;
  }
}

/**
 * Platform announcement bar (docs/adr/0059), rendered by the protected app
 * shell at the very top of the content column, above the sticky header — in the normal document flow, so it
 * never overlaps the header, the page, or the global top progress bar (which
 * is a separate fixed element in the root layout). The shell renders it only
 * when an announcement is live and not dismissed in this browser: no empty
 * bar, no reserved space.
 *
 * Dismiss = a per-browser cookie (read server-side on the next render), never
 * a write to the announcement: it stays published for everyone else.
 * « Contacter le support » opens the existing SupportWidget.
 */
export function AnnouncementBar({ announcement }: { announcement: ActiveAnnouncement }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const style = TYPE_STYLE[announcement.type];
  const Icon = style.icon;
  const actionUrl = announcement.actionLabel ? safeAnnouncementUrl(announcement.actionUrl) : null;

  function dismiss() {
    try {
      const value = addDismissedKey(readCookie(ANNOUNCEMENT_DISMISS_COOKIE), announcement.key);
      document.cookie = `${ANNOUNCEMENT_DISMISS_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${ANNOUNCEMENT_DISMISS_MAX_AGE_SECONDS}; samesite=lax`;
    } catch {
      // Best-effort: hidden for this page view even if the cookie can't be written.
    }
    setDismissed(true);
  }

  // Actions read as small pill buttons on the coloured bar (inherit its text colour).
  const actionClass =
    "inline-flex items-center gap-1 rounded-md bg-black/10 px-2.5 py-1 text-xs font-semibold hover:bg-black/20 focus-visible:ring-2 focus-visible:ring-current focus-visible:outline-none";

  return (
    <section
      aria-label={`Annonce : ${ANNOUNCEMENT_TYPE_LABELS[announcement.type]}`}
      data-announcement-bar
      className={cn("shrink-0 px-3 py-2 shadow-sm md:px-6 print:hidden", style.className)}
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-2">
          <Icon className={cn("size-4 shrink-0", style.iconClass)} aria-hidden="true" />
          {/* Looping ticker (globals.css): the 2nd copy only makes the loop
              seamless and is hidden from assistive tech; reduced motion shows
              one static copy. */}
          <div className="announcement-ticker min-w-0 flex-1 overflow-hidden">
            <div
              className="announcement-ticker-track"
              style={{ "--ticker-duration": `${Math.max(15, Math.round(announcement.message.length * 0.25))}s` } as React.CSSProperties}
            >
              {[false, true].map((duplicate) => (
                <p key={String(duplicate)} className="announcement-ticker-copy text-sm leading-snug font-bold break-words text-white" aria-hidden={duplicate || undefined}>
                  <span className="me-1.5 inline-block rounded bg-black/20 px-1.5 py-px text-[11px] font-bold tracking-wide uppercase">
                    {ANNOUNCEMENT_TYPE_LABELS[announcement.type]}
                  </span>
                  {announcement.message}
                </p>
              ))}
            </div>
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {actionUrl &&
            (isExternalAnnouncementUrl(actionUrl) ? (
              <a href={actionUrl} target="_blank" rel="noopener noreferrer" className={actionClass}>
                {announcement.actionLabel}
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
                <span className="sr-only">(nouvel onglet)</span>
              </a>
            ) : (
              <Link href={actionUrl} className={actionClass}>
                {announcement.actionLabel}
              </Link>
            ))}
          <button type="button" onClick={() => openSupportWidget()} className={actionClass}>
            <LifeBuoy className="size-3.5" aria-hidden="true" />
            Contacter le support
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Masquer cette annonce"
            title="Masquer cette annonce"
            className="rounded-md p-1 opacity-80 hover:bg-black/15 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-current focus-visible:outline-none"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
