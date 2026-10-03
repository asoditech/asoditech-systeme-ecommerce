"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BadgeCheck, MessageCircle, Settings2 } from "lucide-react";
import {
  removeMyWhatsAppNumberAction,
  requestMyWhatsAppVerificationAction,
  saveMyWhatsAppNumberAction,
  setMyWhatsAppOptInAction,
  verifyMyWhatsAppCodeAction,
} from "@/actions/whatsapp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Status = "unavailable" | "no_number" | "pending" | "active" | "disabled";

const STATUS: Record<Status, { label: string; tone: string; text: string }> = {
  unavailable: { label: "Canal indisponible", tone: "border-border text-muted-foreground", text: "" },
  no_number: {
    label: "Non configuré",
    tone: "border-border text-muted-foreground",
    text: "Ajoutez et vérifiez votre numéro WhatsApp pour recevoir les alertes critiques.",
  },
  pending: {
    label: "En attente de vérification",
    tone: "border-amber-300 bg-amber-50 text-amber-800",
    text: "Vérifiez votre numéro pour pouvoir activer les alertes WhatsApp.",
  },
  active: {
    label: "Activé",
    tone: "border-emerald-300 bg-emerald-50 text-emerald-800",
    text: "Les alertes WhatsApp critiques sont activées.",
  },
  disabled: {
    label: "Désactivé",
    tone: "border-border text-muted-foreground",
    text: "Votre numéro WhatsApp est vérifié. Les alertes WhatsApp sont désactivées.",
  },
};

/**
 * « Alertes WhatsApp » — the user's OWN number, verification and opt-in
 * (docs/adr/0058). The single UI for it (Paramètres → Notifications). All
 * rules are enforced server-side by src/actions/whatsapp.ts; this only
 * reflects them. The channel itself (on/off, sender) lives in Intégrations.
 */
export function WhatsAppNotificationsCard({
  status,
  unavailableReason,
  maskedPhone,
  verified,
  optedIn,
  codePending,
  canConfigureChannel,
}: {
  status: Status;
  unavailableReason: "tenant_disabled" | "not_configured" | null;
  maskedPhone: string | null;
  verified: boolean;
  optedIn: boolean;
  codePending: boolean;
  canConfigureChannel: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(!maskedPhone);
  const channelAvailable = status !== "unavailable";

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string, after?: () => void) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(success);
        after?.();
        router.refresh();
      } else {
        toast.error(result.error ?? "Une erreur est survenue.");
      }
    });
  }

  const s = STATUS[status];
  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
          <MessageCircle className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Alertes WhatsApp</CardTitle>
            <Badge variant="outline" className={cn("font-medium", s.tone)}>
              {s.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Uniquement les alertes critiques : rupture de stock, échecs de livraison, erreur d&apos;intégration.
          </p>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {status === "unavailable" ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
            <p>
              {unavailableReason === "not_configured"
                ? "Le canal WhatsApp n'est pas encore disponible sur cette plateforme."
                : canConfigureChannel
                  ? "WhatsApp n'est pas activé pour votre entreprise."
                  : "WhatsApp n'est pas activé pour votre entreprise. Un administrateur peut l'activer dans Intégrations."}{" "}
              Vous pouvez déjà enregistrer votre numéro.
            </p>
            {canConfigureChannel && unavailableReason === "tenant_disabled" && (
              <Button size="sm" variant="outline" render={<Link href="/integrations" />}>
                <Settings2 className="size-3.5" />
                Configurer WhatsApp
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{s.text}</p>
        )}

        {/* Numéro WhatsApp */}
        <div className="space-y-1.5">
          <Label htmlFor="whatsapp-phone">Numéro WhatsApp</Label>
          {editing ? (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              action={(fd) => run(() => saveMyWhatsAppNumberAction(fd), "Numéro enregistré.", () => setEditing(false))}
            >
              <Input
                id="whatsapp-phone"
                name="phone"
                inputMode="tel"
                autoComplete="tel"
                placeholder="06 12 34 56 78"
                className="sm:max-w-64"
                required
              />
              <div className="flex gap-2">
                <Button type="submit" disabled={isPending}>
                  Enregistrer
                </Button>
                {maskedPhone && (
                  <Button type="button" variant="outline" disabled={isPending} onClick={() => setEditing(false)}>
                    Annuler
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{maskedPhone}</span>
                {verified ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                    <BadgeCheck className="size-3.5" /> Vérifié
                  </span>
                ) : (
                  <span className="text-xs font-medium text-amber-700">Non vérifié</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={() => setEditing(true)}>
                  Modifier
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={isPending}
                  onClick={() => run(removeMyWhatsAppNumberAction, "Numéro supprimé.", () => setEditing(true))}
                >
                  Supprimer
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Vérification */}
        {maskedPhone && !verified && !editing && (
          <div className="space-y-3 rounded-lg border border-dashed border-border px-3 py-3">
            <div>
              <p className="text-sm font-medium">Vérification</p>
              <p className="text-xs text-muted-foreground">
                Un code à 6 chiffres est envoyé sur ce numéro WhatsApp pour confirmer qu&apos;il vous appartient.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={isPending || !channelAvailable}
              onClick={() => run(requestMyWhatsAppVerificationAction, "Code envoyé sur WhatsApp.")}
            >
              {codePending ? "Renvoyer le code" : "Vérifier le numéro"}
            </Button>
            {codePending && (
              <form className="flex flex-wrap items-end gap-2" action={(fd) => run(() => verifyMyWhatsAppCodeAction(fd), "Numéro vérifié.")}>
                <div className="w-40 space-y-1.5">
                  <Label htmlFor="whatsapp-code">Code reçu</Label>
                  <Input
                    id="whatsapp-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    pattern="\d{6}"
                    required
                  />
                </div>
                <Button type="submit" size="sm" disabled={isPending}>
                  Confirmer
                </Button>
              </form>
            )}
          </div>
        )}

        {/* Opt-in */}
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border/70 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">{optedIn ? "Notifications activées" : "Notifications désactivées"}</p>
            <p className="text-xs text-muted-foreground">
              {verified
                ? "Recevoir les alertes critiques sur WhatsApp. Désactivable à tout moment."
                : "Disponible après la vérification de votre numéro."}
            </p>
          </div>
          <Switch
            checked={optedIn}
            aria-label="Recevoir les alertes WhatsApp"
            disabled={isPending || (!verified && !optedIn)}
            onCheckedChange={(next) =>
              run(() => setMyWhatsAppOptInAction(next), next ? "Alertes WhatsApp activées." : "Alertes WhatsApp désactivées.")
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
