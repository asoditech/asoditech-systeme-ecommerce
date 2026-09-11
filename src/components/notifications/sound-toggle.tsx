"use client";

import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { isSoundEnabled, setSoundEnabled } from "@/lib/notification-sound";

/**
 * Client-only preference — never touches the database. Purely gates
 * whether NotificationSoundListener plays a sound; it never affects
 * whether/how a Notification row is created or delivered (see ADR 0016's
 * addendum). Defaults to enabled, stored in localStorage.
 *
 * Renders the SSR-safe default (`true`) on both the server and the
 * client's first paint — reading the *real* stored value only in an
 * effect, after mount. Reading it any earlier (e.g. a lazy `useState`
 * initializer) would make the client's first render disagree with the
 * server-rendered HTML whenever the stored preference is `false`,
 * which is a genuine hydration-mismatch error, not just a lint nitpick.
 */
export function SoundToggle() {
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see the block comment above: this one is intentional and hydration-safe, not a lint nitpick.
    setEnabled(isSoundEnabled());
  }, []);

  function toggle(next: boolean) {
    setEnabled(next);
    setSoundEnabled(next);
  }

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      {enabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
      <span>Sons des notifications</span>
      <Switch checked={enabled} onCheckedChange={toggle} aria-label="Sons des notifications" />
    </div>
  );
}
