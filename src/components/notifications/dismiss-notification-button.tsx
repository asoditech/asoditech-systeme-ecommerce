"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import { dismissNotificationAction } from "@/actions/notifications";

/** The "x" that hides one notification — a real delete (see the action's
 * own doc comment), distinct from "Tout marquer comme lu" which only
 * changes read state and keeps every notification in the list. */
export function DismissNotificationButton({ id, className = "" }: { id: string; className?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      aria-label="Masquer cette notification"
      onClick={(event) => {
        event.stopPropagation();
        startTransition(async () => {
          await dismissNotificationAction(id);
          router.refresh();
        });
      }}
      className={`rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 ${className}`}
    >
      <X className="size-3.5" />
    </button>
  );
}
