"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings, Plug } from "lucide-react";
import { configureDeliveryProviderApiAction, testDeliveryProviderConnectionAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { INTEGRATION_STATUS_LABELS } from "@/lib/status-labels";
import type { ActionResult, IdResult } from "@/actions/types";
import type { IntegrationStatus } from "@prisma/client";

interface AvailableConnector {
  key: string;
  displayName: string;
  capabilities: string[];
}

/**
 * Connection lifecycle UI for an API-type ShippingProvider — mirrors the
 * WooCommerce/Shopify card pattern (badge never claims Connecté from
 * credential-save alone; a separate "Tester la connexion" is the only
 * path that can). See docs/adr/0012-delivery-provider-integration.md.
 */
export function ProviderConnectionStatus({ status }: { status: IntegrationStatus | null }) {
  const meta = INTEGRATION_STATUS_LABELS[status ?? "DECONNECTE"];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

export function ProviderConnectionControls({
  providerId,
  providerKey,
  connectors,
}: {
  providerId: string;
  providerKey: string | null;
  connectors: AvailableConnector[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isTesting, startTest] = useTransition();

  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      const result = await configureDeliveryProviderApiAction(formData);
      if (result.ok) {
        toast.success("Connecteur configuré. Testez la connexion pour la vérifier.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  function testConnection() {
    startTest(async () => {
      const fd = new FormData();
      fd.set("providerId", providerId);
      const result = await testDeliveryProviderConnectionAction(fd);
      if (result.ok) toast.success("Connexion réussie.");
      else toast.error(result.error);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={connectors.length === 0} />}>
          <Settings className="size-4" />
          Configurer
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configurer le connecteur</DialogTitle>
          </DialogHeader>
          {connectors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun connecteur de transporteur n&apos;est disponible sur ce déploiement pour le moment.
            </p>
          ) : (
            <form action={formAction} className="space-y-4">
              <input type="hidden" name="providerId" value={providerId} />
              <div className="space-y-1.5">
                <Label htmlFor="providerKey">Connecteur</Label>
                <Select name="providerKey" required defaultValue={providerKey ?? undefined}>
                  <SelectTrigger id="providerKey" className="w-full">
                    <SelectValue placeholder="Choisir un connecteur">
                      {(value: string) => connectors.find((c) => c.key === value)?.displayName ?? "Choisir un connecteur"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {connectors.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="credentialsJson">Identifiants (JSON)</Label>
                <Textarea id="credentialsJson" name="credentialsJson" rows={4} placeholder='{"apiKey": "..."}' required />
                <p className="text-xs text-muted-foreground">
                  Fourni par le transporteur lors de la mise en place du connecteur. Jamais affiché à nouveau après
                  l&apos;enregistrement.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="configJson">Configuration (JSON, optionnel)</Label>
                <Textarea id="configJson" name="configJson" rows={2} placeholder="{}" />
              </div>
              {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Enregistrement..." : "Enregistrer"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
      {providerKey && (
        <Button type="button" variant="outline" size="sm" disabled={isTesting} onClick={testConnection}>
          <Plug className="size-4" />
          {isTesting ? "Test..." : "Tester la connexion"}
        </Button>
      )}
    </div>
  );
}
