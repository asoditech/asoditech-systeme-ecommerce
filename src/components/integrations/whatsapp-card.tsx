import Link from "next/link";
import { AlertCircle, BellRing, Clock, Phone } from "lucide-react";
import { BrandTile } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectionStatusPill } from "@/components/integrations/connection-status-pill";
import { WhatsAppActions } from "@/components/integrations/whatsapp-actions";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";
import { isWhatsAppConfigured } from "@/lib/whatsapp/client";

/**
 * WhatsApp critical notifications (docs/adr/0058). The sender is ONE
 * central ASODITECH WhatsApp Business number (server env vars) — this
 * card is only the tenant's on/off switch (SYSTEM/INTEGRATION config).
 * Each user's own number and opt-in live in Paramètres → Notifications.
 * Never shows a credential.
 */
export async function WhatsAppCard({ canManage }: { canManage: boolean }) {
  const integration = await prisma.integration.findFirst({ where: { provider: "WHATSAPP" } });
  const status = integration?.status ?? "DECONNECTE";
  const config = (integration?.config as { displayPhoneNumber?: string | null } | null) ?? null;
  const configured = isWhatsAppConfigured();

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BrandTile brand="whatsapp" label="WhatsApp" />
          <div>
            <CardTitle>WhatsApp Business</CardTitle>
            <p className="text-xs text-muted-foreground">Configuration du canal d&apos;envoi</p>
            <ConnectionStatusPill status={status} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 text-xs text-muted-foreground">
        <p>
          Alertes critiques (rupture de stock, échecs de livraison, erreur d&apos;intégration) envoyées sur WhatsApp
          aux membres de l&apos;équipe qui ont vérifié leur numéro et accepté de les recevoir (Paramètres → Notifications). Les
          droits et emplacements de chacun s&apos;appliquent. Ce réglage active le canal pour l&apos;entreprise ; chacun choisit
          ensuite de recevoir ou non ses alertes.
        </p>
        {!configured && (
          <p className="rounded-md bg-muted/60 px-3 py-2">Le numéro d&apos;envoi ASODITECH n&apos;est pas configuré sur ce serveur.</p>
        )}
        {config?.displayPhoneNumber && status === "CONNECTE" && (
          <div className="flex items-center gap-1.5">
            <Phone className="size-3.5 shrink-0" />
            Numéro d&apos;envoi : {config.displayPhoneNumber}
          </div>
        )}
        {integration?.lastError && status === "ERREUR" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/8 px-3 py-2 text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <p>{integration.lastError}</p>
          </div>
        )}
        {integration?.lastConnectionCheckAt && (
          <div className="flex items-center gap-1.5">
            <Clock className="size-3.5 shrink-0" />
            Dernière vérification : {formatDateTime(integration.lastConnectionCheckAt)}
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2">
        {canManage && <WhatsAppActions enabled={status === "CONNECTE"} hasRow={Boolean(integration) && status !== "DECONNECTE"} />}
        <Button size="sm" variant="ghost" className="ml-auto" render={<Link href="/parametres/notifications" />}>
          <BellRing className="size-3.5" />
          Mes notifications WhatsApp
        </Button>
      </CardFooter>
    </Card>
  );
}
