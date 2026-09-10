"use client";

import { MessageCircle, Phone, Mail, Clock } from "lucide-react";
import { buildTelHref, buildWhatsAppUrl } from "@/lib/support/contact";
import { buildSupportMessage, type SupportContext } from "@/lib/support/context";
import { ReportProblemDialog } from "@/components/support/report-problem-dialog";
import type { SupportWidgetConfig } from "@/components/support/support-widget";

/**
 * "Besoin d'aide supplémentaire ?" — WhatsApp, phone and "signaler un
 * problème". Every contact channel comes from the tenant's configured
 * support settings; a channel with no configured value is simply not
 * shown. WhatsApp and phone are independent — a phone number is never
 * assumed to be reachable on WhatsApp.
 */
export function SupportContactSection({
  config,
  context,
  pageUrl,
  hasContact,
}: {
  config: SupportWidgetConfig;
  context: SupportContext;
  pageUrl?: string;
  hasContact: boolean;
}) {
  const message = buildSupportMessage({
    companyName: config.companyName,
    context,
    pageUrl,
  });
  const whatsappUrl = buildWhatsAppUrl(config.whatsapp, message);
  const telHref = buildTelHref(config.phone);

  return (
    <section className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground uppercase">Besoin d&apos;aide supplémentaire&nbsp;?</div>

      {config.name && <p className="text-xs text-muted-foreground">{config.name}</p>}
      {config.hours && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" />
          {config.hours}
        </p>
      )}

      <div className="space-y-1.5">
        {whatsappUrl && (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <MessageCircle className="size-4 text-[#25D366]" />
            WhatsApp
          </a>
        )}

        {telHref && (
          <a
            href={telHref}
            className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <Phone className="size-4 text-primary" />
            Appeler le support
          </a>
        )}

        {config.email && !whatsappUrl && !telHref && (
          <a
            href={`mailto:${config.email}`}
            className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            <Mail className="size-4 text-primary" />
            Écrire au support
          </a>
        )}

        <ReportProblemDialog context={context} pageUrl={pageUrl} />
      </div>

      {!hasContact && (
        <p className="text-[11px] text-muted-foreground">
          Aucun contact de support n&apos;est encore configuré. Un administrateur peut l&apos;ajouter dans Paramètres →
          Support &amp; assistance.
        </p>
      )}
    </section>
  );
}
