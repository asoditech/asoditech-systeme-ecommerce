import { Phone } from "lucide-react";
import { cn } from "@/lib/utils";
import { phoneTelHref, phoneWhatsAppHref } from "@/lib/phone-links";

/**
 * A stored contact number shown as-is, with a click-to-call link and, when
 * `whatsapp` is set and the number is unambiguous (src/lib/phone-links.ts),
 * a WhatsApp button. Plain anchors — no client JS — so it works in server
 * pages. On a phone `tel:` opens the dialer; on a desktop it falls back to
 * the OS handler (or nothing), and WhatsApp opens WhatsApp Web.
 * A number that can't make a valid href is rendered as plain text.
 */
export function PhoneActions({
  phone,
  whatsapp = false,
  className,
}: {
  phone: string | null | undefined;
  /** Offer WhatsApp (customers, suppliers) — not for e.g. a courier's line. */
  whatsapp?: boolean;
  className?: string;
}) {
  const display = phone?.trim();
  if (!display) return null;
  const tel = phoneTelHref(display);
  const wa = whatsapp ? phoneWhatsAppHref(display) : null;

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {tel ? (
        <a
          href={tel}
          aria-label={`Appeler ${display}`}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{display}</span>
        </a>
      ) : (
        <span>{display}</span>
      )}
      {wa && (
        <a
          href={wa}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Écrire sur WhatsApp à ${display}`}
          title="WhatsApp"
          className="inline-flex size-8 items-center justify-center rounded-md border border-emerald-200 text-emerald-700 transition-colors hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-emerald-900/50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
        >
          <WhatsAppGlyph className="size-4" />
        </a>
      )}
    </span>
  );
}

/** Same glyph as the confirmation queue's WhatsApp button. */
function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="currentColor" aria-hidden="true">
      <path d="M16.001 7C11.03 7 7 11.03 7 16c0 1.77.51 3.42 1.4 4.81L7.6 24.4l3.68-.97a8.96 8.96 0 004.72 1.34c4.97 0 9-4.03 9-9s-4.03-9-9-9zm5.2 12.79c-.22.61-1.08 1.12-1.77 1.27-.47.1-1.09.18-3.17-.68-2.66-1.1-4.37-3.78-4.5-3.96-.13-.18-1.08-1.43-1.08-2.73 0-1.29.68-1.93.92-2.19.24-.26.53-.33.7-.33l.5.01c.16 0 .38-.06.59.45.22.53.74 1.82.8 1.95.07.14.11.29.02.47-.09.18-.14.29-.27.45-.14.16-.29.35-.41.47-.14.14-.28.29-.12.56.16.27.71 1.17 1.52 1.9 1.05.94 1.93 1.23 2.2 1.37.27.14.43.11.59-.07.16-.18.68-.79.86-1.06.18-.27.36-.22.61-.13.25.09 1.57.74 1.84.88.27.14.45.2.52.32.07.11.07.65-.15 1.26z" />
    </svg>
  );
}
