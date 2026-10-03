import Link from "next/link";
import { Bell, Check, ListChecks, Mail, MapPin, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SoundToggle } from "@/components/notifications/sound-toggle";
import type { AlertRule, Channel, WhatsAppStatus } from "@/lib/notification-settings";
import { cn } from "@/lib/utils";

/**
 * Paramètres → Notifications building blocks (docs/adr/0058 "Final
 * responsibility split"). Informational except where a control maps to a
 * real backend behaviour: the sound switch (this browser only) and the
 * WhatsApp opt-in (WhatsAppNotificationsCard). No fake switches.
 */

function SectionIcon({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", className)}>{children}</div>;
}

export function InAppChannelCard() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <SectionIcon className="bg-primary/10 text-primary">
          <Bell className="size-4.5" />
        </SectionIcon>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Dans l&apos;application</CardTitle>
            <Badge variant="outline" className="border-emerald-300 bg-emerald-50 font-medium text-emerald-800">
              Toujours actif
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Toutes les alertes qui vous concernent arrivent dans la cloche et sur la page Notifications.
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <SoundToggle />
        <Button size="sm" variant="outline" render={<Link href="/notifications" />}>
          Voir mes notifications
        </Button>
      </CardContent>
    </Card>
  );
}

export function EmailChannelCard({ address, available }: { address: string; available: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <SectionIcon className="bg-sky-500/10 text-sky-600">
          <Mail className="size-4.5" />
        </SectionIcon>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Alertes par email</CardTitle>
            <Badge
              variant="outline"
              className={cn("font-medium", available ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "text-muted-foreground")}
            >
              {available ? "Activé" : "Canal indisponible"}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Les alertes critiques sont envoyées à l&apos;adresse de votre compte.
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/70 px-3 py-2">
          <span className="text-muted-foreground">Adresse :</span>
          <span className="break-all font-medium">{address}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {available
            ? "Les alertes critiques par email ne se désactivent pas individuellement. Les emails de compte (invitation, mot de passe) ne sont pas des alertes."
            : "L'envoi d'emails n'est pas configuré sur cette plateforme : aucune alerte n'est envoyée par email pour le moment."}
        </p>
      </CardContent>
    </Card>
  );
}

const CHANNEL_LABEL: Record<Channel, string> = { inApp: "Application", email: "Email", whatsapp: "WhatsApp" };

export function AlertPreferencesCard({
  alerts,
  emailAvailable,
  whatsappStatus,
  locationScope,
}: {
  alerts: AlertRule[];
  emailAvailable: boolean;
  whatsappStatus: WhatsAppStatus;
  locationScope: { global: boolean; count: number };
}) {
  const live: Record<Channel, boolean> = { inApp: true, email: emailAvailable, whatsapp: whatsappStatus === "active" };
  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <SectionIcon className="bg-violet-500/10 text-violet-600">
          <ListChecks className="size-4.5" />
        </SectionIcon>
        <div className="min-w-0">
          <CardTitle className="text-base">Préférences d&apos;alertes</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Les alertes que vous recevez selon vos droits, et par quel canal. Chaque canal n&apos;est pas disponible pour chaque
            alerte.
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">Votre rôle ne reçoit aucune alerte automatique pour le moment.</p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
            {alerts.map((a) => (
              <li key={a.key} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{a.label}</p>
                  {(a.note || (a.locationScoped && !locationScope.global)) && (
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      {a.locationScoped && !locationScope.global && (
                        <span className="inline-flex items-center gap-1">
                          <MapPin className="size-3" />
                          Vos emplacements uniquement ({locationScope.count})
                        </span>
                      )}
                      {a.note && <span>{a.note}</span>}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  {(["inApp", "email", "whatsapp"] as const).map((c) => {
                    const supported = a.channels.includes(c);
                    const on = supported && live[c];
                    return (
                      <span
                        key={c}
                        title={!supported ? "Non disponible pour cette alerte" : on ? "Actif" : "Canal désactivé ou indisponible"}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs",
                          on
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                            : supported
                              ? "border-border text-muted-foreground"
                              : "border-dashed border-border/70 text-muted-foreground/60"
                        )}
                      >
                        {on ? <Check className="size-3" /> : <Minus className="size-3" />}
                        {CHANNEL_LABEL[c]}
                      </span>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Check className="size-3 text-emerald-700" /> envoyé à vous · <Minus className="size-3" /> non envoyé (canal inactif ou non
          proposé pour cette alerte)
        </p>
      </CardContent>
    </Card>
  );
}
