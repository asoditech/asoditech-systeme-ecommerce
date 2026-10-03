import Link from "next/link";
import { BellRing, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { isEmailConfigured } from "@/lib/email";
import { cn } from "@/lib/utils";

/**
 * Email delivery status (docs/adr/0057/0058). Read-only: the sender
 * (Resend) is configured by the platform operator through server env
 * vars — there is nothing a tenant can or should edit here, and no
 * credential is ever shown. Users see where their alerts go in
 * Paramètres → Notifications.
 */
export function EmailCard() {
  const configured = isEmailConfigured();
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-sky-50 text-sky-600">
          <Mail className="size-5" />
        </div>
        <div>
          <CardTitle>Email</CardTitle>
          <p className="text-xs text-muted-foreground">Envoi des emails (géré par la plateforme)</p>
          <Badge
            variant="outline"
            className={cn("mt-1 font-medium", configured ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "text-muted-foreground")}
          >
            {configured ? "Actif" : "Non configuré"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        Invitations, réinitialisation du mot de passe, signalements du centre d&apos;aide et alertes critiques (rupture de stock,
        échec de livraison, erreur d&apos;intégration, limite du forfait) envoyées à l&apos;adresse de chaque utilisateur concerné.
        {!configured && " L'envoi n'est pas encore configuré sur cette plateforme : les emails ne partent pas."}
      </CardContent>
      <CardFooter>
        <Button size="sm" variant="ghost" className="ml-auto" render={<Link href="/parametres/notifications" />}>
          <BellRing className="size-3.5" />
          Mes notifications par email
        </Button>
      </CardFooter>
    </Card>
  );
}
