"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { connectIntegrationAction } from "@/actions/integrations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { IntegrationProvider } from "@prisma/client";
import type { ActionResult, IdResult } from "@/actions/types";

export function ConnectIntegrationDialog({ provider, label }: { provider: IntegrationProvider; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await connectIntegrationAction(formData);
      if (result.ok) {
        toast.success("Identifiants enregistrés.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" />}>Configurer</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configurer {label}</DialogTitle>
          <DialogDescription>
            {provider === "WOOCOMMERCE" ? (
              <>
                Ces identifiants sont chiffrés et stockés en toute sécurité. Utilisez la clé et le secret
                consommateur générés dans WooCommerce (WooCommerce → Réglages → Avancé → REST API). Enregistrer
                ne vérifie pas encore la connexion — utilisez ensuite « Tester la connexion ».
              </>
            ) : provider === "SHOPIFY" ? (
              <>
                Ces identifiants sont chiffrés et stockés en toute sécurité. Utilisez le jeton d&apos;accès
                Admin API d&apos;une application personnalisée Shopify existante. Enregistrer ne vérifie pas
                encore la connexion — utilisez ensuite « Tester la connexion ».
              </>
            ) : (
              <>
                Ces identifiants sont chiffrés et stockés en toute sécurité. Aucune synchronisation automatique
                n&apos;est encore active — l&apos;adaptateur {label} sera implémenté dans une phase ultérieure.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="provider" value={provider} />
          <div className="space-y-1.5">
            <Label htmlFor="siteUrl">{provider === "SHOPIFY" ? "Nom de la boutique Shopify" : "URL de la boutique"}</Label>
            <Input
              id="siteUrl"
              name="siteUrl"
              type={provider === "SHOPIFY" ? "text" : "url"}
              placeholder={provider === "SHOPIFY" ? "mon-magasin ou mon-magasin.myshopify.com" : "https://maboutique.com"}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apiKey">{provider === "SHOPIFY" ? "Jeton d'accès Admin API" : "Clé API"}</Label>
            <Input id="apiKey" name="apiKey" type="password" autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apiSecret">{provider === "SHOPIFY" ? "Secret webhook (Client secret) — optionnel" : "Secret API"}</Label>
            <Input id="apiSecret" name="apiSecret" type="password" autoComplete="off" />
            {provider === "SHOPIFY" && (
              <p className="text-xs text-muted-foreground">
                Requis uniquement pour vérifier les webhooks Shopify (Client secret de l&apos;application
                personnalisée). Laissez vide si vous n&apos;utilisez que la synchronisation manuelle.
              </p>
            )}
          </div>
          {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
