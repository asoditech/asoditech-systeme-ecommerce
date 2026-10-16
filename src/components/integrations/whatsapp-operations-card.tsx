import { Activity, CheckCircle2, CircleSlash, MessageSquareText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WhatsAppCategorySwitch, WhatsAppRetryButton } from "@/components/integrations/whatsapp-operations-controls";
import { formatDateTime } from "@/lib/format";
import { getWhatsAppOperationsOverview } from "@/lib/queries/whatsapp-outbox";
import type { OutboxStatus } from "@/lib/whatsapp/outbox-rules";
import { companyCategorySwitchState, type WhatsAppSwitchTone } from "@/lib/whatsapp/ui-state";
import { cn } from "@/lib/utils";

/**
 * Intégrations → « Alertes WhatsApp — suivi » (docs/adr/0058 addendum).
 * Rendered only for `integrations.manage` holders (the page checks; every
 * action re-checks on the server). Current tenant only. Shows: is WhatsApp
 * usable, the company-level category switches, the templates the central
 * account needs (available / not approved) and the last 20 sends — by
 * recipient NAME, never a number; errors are already sanitized.
 */

const STATUS_LABEL: Record<OutboxStatus, string> = {
  EN_ATTENTE: "En attente",
  EN_COURS: "En cours",
  ENVOYE: "Envoyé",
  ECHEC: "Échec",
  IGNORE: "Ignoré",
};

const STATUS_TONE: Record<OutboxStatus, string> = {
  EN_ATTENTE: "bg-pill-yellow text-pill-yellow-fg",
  EN_COURS: "bg-pill-blue text-pill-blue-fg",
  ENVOYE: "bg-pill-green text-pill-green-fg",
  ECHEC: "bg-pill-red text-pill-red-fg",
  IGNORE: "bg-pill-neutral text-ink-secondary",
};

const SWITCH_TONE: Record<WhatsAppSwitchTone, string> = {
  active: "text-pill-green-fg",
  inactive: "text-pill-yellow-fg",
  off: "text-muted-foreground",
};

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        ok ? "bg-pill-green text-pill-green-fg" : "bg-pill-neutral text-ink-secondary"
      )}
    >
      {ok ? <CheckCircle2 className="size-3" /> : <CircleSlash className="size-3" />}
      {children}
    </span>
  );
}

export async function WhatsAppOperationsCard() {
  const o = await getWhatsAppOperationsOverview();
  const usable = o.senderConfigured && o.tenantEnabled;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-pill-green text-pill-green-fg">
          <MessageSquareText className="size-4.5" />
        </span>
        <div className="min-w-0">
          <CardTitle>Alertes WhatsApp — suivi</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Alertes internes à l&apos;équipe : catégories actives pour l&apos;entreprise, modèles Meta nécessaires et derniers envois.
            Chaque membre garde ses propres choix dans Paramètres → Notifications.
          </p>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <Pill ok={o.senderConfigured}>{o.senderConfigured ? "Numéro d'envoi configuré" : "Numéro d'envoi non configuré"}</Pill>
          <Pill ok={o.tenantEnabled}>{o.tenantEnabled ? "Canal activé pour l'entreprise" : "Canal désactivé pour l'entreprise"}</Pill>
          <Pill ok={o.retryScheduleConfigured}>
            {o.retryScheduleConfigured ? "Relances automatiques configurées" : "Relances automatiques non configurées"}
          </Pill>
          {o.counts.waiting > 0 && <span className="text-xs text-muted-foreground">{o.counts.waiting} en attente d&apos;envoi</span>}
          {o.counts.failed > 0 && <span className="text-xs text-destructive">{o.counts.failed} en échec</span>}
        </div>
        {!usable && (
          <p className="rounded-xl bg-pill-neutral px-3 py-2 text-xs text-muted-foreground">
            Tant que le canal n&apos;est pas utilisable, aucune alerte WhatsApp n&apos;est enregistrée ni envoyée (l&apos;application et
            l&apos;e-mail ne changent pas).
          </p>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold">Catégories d&apos;alertes</h3>
          <ul className="divide-y divide-hairline rounded-lg border border-hairline">
            {o.categories.map((c) => {
              // The switch shows the stored company preference; the label
              // says whether it has any effect right now (never « Activée »
              // while the channel itself cannot send).
              const state = companyCategorySwitchState({
                enabledForCompany: c.enabledForCompany,
                senderConfigured: o.senderConfigured,
                tenantEnabled: o.tenantEnabled,
                templateAvailable: c.templateAvailable,
              });
              return (
              <li key={c.type} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="text-xs text-muted-foreground">
                    Modèle <code className="font-mono">{c.templateName}</code> —{" "}
                    {c.templateAvailable ? (
                      <span className="text-pill-green-fg">disponible</span>
                    ) : (
                      <span className="text-pill-yellow-fg">non approuvé (aucun envoi tant qu&apos;il n&apos;est pas déclaré)</span>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn("font-medium", SWITCH_TONE[state.tone])} data-switch-state={state.tone}>
                    {state.label}
                  </span>
                  <WhatsAppCategorySwitch type={c.type} label={c.label} enabled={c.enabledForCompany} />
                </div>
              </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Modèles Meta requis (langue fr)</h3>
          <ul className="space-y-1.5 text-xs">
            {o.templates.map((t) => (
              <li key={t.name} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
                <code className="font-mono font-medium">{t.name}</code>
                <span className={t.available ? "text-pill-green-fg" : "text-pill-yellow-fg"}>
                  {t.available ? "disponible" : "non approuvé"}
                </span>
                <span className="text-muted-foreground">
                  {t.category === "AUTHENTICATION" ? "Authentification" : "Utilitaire"} · « {t.body} » · paramètres :{" "}
                  {t.parameters.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Activity className="size-3.5" />
            Derniers envois
          </h3>
          {o.recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">Aucune alerte WhatsApp enregistrée pour le moment.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-hairline">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Catégorie</TableHead>
                    <TableHead>Destinataire</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Détail</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.recent.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.sentAt ?? r.createdAt)}</TableCell>
                      <TableCell className="text-xs">{r.alertLabel}</TableCell>
                      <TableCell className="text-xs">{r.recipientName}</TableCell>
                      <TableCell>
                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", STATUS_TONE[r.status])}>
                          {STATUS_LABEL[r.status]}
                        </span>
                        {r.attempts > 1 && <span className="ml-1 text-xs text-muted-foreground">({r.attempts} essais)</span>}
                      </TableCell>
                      <TableCell className="max-w-72 text-xs text-muted-foreground">{r.lastError ?? "—"}</TableCell>
                      <TableCell className="text-right">{r.status === "ECHEC" && <WhatsAppRetryButton id={r.id} />}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
