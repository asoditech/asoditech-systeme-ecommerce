"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Copy, Settings, Plug } from "lucide-react";
import { configureDeliveryProviderApiAction, testDeliveryProviderConnectionAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/components/ui/notice";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { INTEGRATION_STATUS_LABELS } from "@/lib/status-labels";
import type { AvailableDeliveryConnector } from "@/lib/queries/delivery";
import type { ActionResult, IdResult } from "@/actions/types";
import type { IntegrationStatus } from "@prisma/client";

/**
 * Connection lifecycle UI for an API-type ShippingProvider — mirrors the
 * WooCommerce/Shopify card pattern (badge never claims Connecté from
 * credential-save alone; a separate "Tester la connexion" is the only
 * path that can). See docs/adr/0012-delivery-provider-integration.md.
 *
 * When the selected connector declares `credentialFields` (e.g. OzonExpress
 * → identifiant client + clé API), proper typed inputs are rendered and
 * assembled into the credentials JSON client-side; otherwise the raw-JSON
 * editor is shown. Either way, credentials are POSTed once to the Server
 * Action, encrypted at rest, and never sent back to the browser.
 */
export function ProviderConnectionStatus({ status }: { status: IntegrationStatus | null }) {
  const meta = INTEGRATION_STATUS_LABELS[status ?? "DECONNECTE"];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

const CRED_FIELD_PREFIX = "cred__";

/**
 * Path of the generic carrier webhook for one connection (docs/adr/0060).
 * It carries only the ShippingProvider id — never the webhook secret, which
 * is a write-only credential field and is never sent back to the browser.
 */
export function deliveryWebhookPath(providerId: string): string {
  return `/api/webhooks/delivery/${encodeURIComponent(providerId)}`;
}

/**
 * Read-only, fully visible webhook URL (wraps instead of being clipped) with
 * a « Copier » button. Clipboard API first; when it is unavailable or
 * refused, the text is selected so the operator can copy it by hand.
 */
export function WebhookUrlField({ url }: { url: string }) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [feedback, setFeedback] = useState<"" | "copied" | "manual">("");

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setFeedback("copied");
    } catch {
      fieldRef.current?.focus();
      fieldRef.current?.select();
      setFeedback("manual");
    }
    setTimeout(() => setFeedback(""), 2000);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor="webhookUrl">URL du webhook à coller chez le transporteur</Label>
      <div className="flex items-start gap-2">
        <textarea
          id="webhookUrl"
          ref={fieldRef}
          readOnly
          rows={2}
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 resize-none break-all rounded-lg border border-input bg-muted/40 px-2.5 py-1.5 font-mono text-xs leading-relaxed text-ink outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="button" variant="outline" size="sm" onClick={copy} aria-label="Copier l'URL du webhook">
          {feedback === "copied" ? <Check className="size-4" /> : <Copy className="size-4" />}
          {feedback === "copied" ? "Copié" : "Copier"}
        </Button>
      </div>
      {/* « Copié » is already on the button; the region announces it, and shows only the manual-copy hint. */}
      <p aria-live="polite" role="status" className={feedback === "manual" ? "text-xs text-muted-foreground" : "sr-only"}>
        {feedback === "copied" ? "Copié" : feedback === "manual" ? "Copie automatique impossible : l'URL est sélectionnée, copiez-la avec ⌘C / Ctrl+C." : ""}
      </p>
      <p className="text-xs text-muted-foreground">
        Renseignez aussi le même secret webhook ici et chez le transporteur. Le secret n&apos;est jamais réaffiché après l&apos;enregistrement.
      </p>
    </div>
  );
}

export function ProviderConnectionControls({
  providerId,
  providerKey,
  connectors,
}: {
  providerId: string;
  providerKey: string | null;
  connectors: AvailableDeliveryConnector[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isTesting, startTest] = useTransition();
  const [selectedKey, setSelectedKey] = useState<string | null>(providerKey);
  // Retired connectors stay listed only for the connection already using them.
  const choices = connectors.filter((c) => c.acceptsNewConnections || c.key === providerKey);

  const selectedConnector = connectors.find((c) => c.key === selectedKey) ?? null;
  const typedFields = selectedConnector?.credentialFields ?? [];
  const useTypedFields = typedFields.length > 0;

  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<IdResult> | undefined, formData: FormData) => {
      // When the connector uses typed fields, assemble the credentials JSON
      // object here from the individual inputs so the operator never has to
      // hand-write JSON. The Server Action still validates the envelope and
      // the adapter validates the field shape.
      const key = String(formData.get("providerKey") ?? "");
      const connector = connectors.find((c) => c.key === key);
      if (connector && connector.credentialFields.length > 0) {
        const credentials: Record<string, string> = {};
        for (const field of connector.credentialFields) {
          const value = String(formData.get(`${CRED_FIELD_PREFIX}${field.name}`) ?? "").trim();
          formData.delete(`${CRED_FIELD_PREFIX}${field.name}`);
          if (value) credentials[field.name] = value;
        }
        formData.set("credentialsJson", JSON.stringify(credentials));
      }

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
      if (result.ok) {
        const detail = result.data.details
          ? Object.entries(result.data.details)
              .map(([k, v]) => `${k} : ${v}`)
              .join(" · ")
          : undefined;
        toast.success(detail ? `Connexion réussie — ${detail}` : "Connexion réussie.");
      } else {
        toast.error(result.error);
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={choices.length === 0} />}>
          <Settings className="size-4" />
          Configurer
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configurer le connecteur</DialogTitle>
          </DialogHeader>
          {choices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun connecteur de transporteur n&apos;est disponible sur ce déploiement pour le moment.
            </p>
          ) : (
            <form action={formAction} className="space-y-4">
              <input type="hidden" name="providerId" value={providerId} />
              <div className="space-y-1.5">
                <Label htmlFor="providerKey">Connecteur</Label>
                <Select
                  name="providerKey"
                  required
                  defaultValue={providerKey ?? undefined}
                  onValueChange={(value: string | null) => setSelectedKey(value)}
                >
                  <SelectTrigger id="providerKey" className="w-full">
                    <SelectValue placeholder="Choisir un connecteur">
                      {(value: string) => connectors.find((c) => c.key === value)?.displayName ?? "Choisir un connecteur"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((c) => (
                      <SelectItem key={c.key} value={c.key}>
                        {c.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedConnector?.notice && (
                <Notice tone="warning" className="block">
                  {selectedConnector.notice}
                </Notice>
              )}

              {/* The URL to paste in the carrier's account (generic route, docs/adr/0060):
                  one per connection, so the tenant and secret come from the connection. */}
              {selectedConnector?.capabilities.includes("WEBHOOKS") && (
                <WebhookUrlField
                  // Dialog content only renders client-side once opened: window is available.
                  url={`${typeof window === "undefined" ? "" : window.location.origin}${deliveryWebhookPath(providerId)}`}
                />
              )}

              {useTypedFields ? (
                <div className="space-y-3">
                  {typedFields.map((field) => (
                    <div key={field.name} className="space-y-1.5">
                      <Label htmlFor={`${CRED_FIELD_PREFIX}${field.name}`}>
                        {field.label}
                        {field.required ? " *" : ""}
                      </Label>
                      <Input
                        id={`${CRED_FIELD_PREFIX}${field.name}`}
                        name={`${CRED_FIELD_PREFIX}${field.name}`}
                        type={field.type === "password" ? "password" : "text"}
                        autoComplete="off"
                        required={field.required}
                      />
                      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="credentialsJson">Identifiants (JSON)</Label>
                  <Textarea id="credentialsJson" name="credentialsJson" rows={4} placeholder='{"apiKey": "..."}' required />
                  <p className="text-xs text-muted-foreground">
                    Fourni par le transporteur lors de la mise en place du connecteur. Jamais affiché à nouveau après
                    l&apos;enregistrement.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="configJson">Configuration (JSON, optionnel)</Label>
                <Textarea id="configJson" name="configJson" rows={2} placeholder="{}" />
              </div>
              {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
              <DialogFooter>
                {/* Closes without saving: nothing is submitted, the form state is discarded. */}
                <DialogClose render={<Button type="button" variant="outline" disabled={isPending} />}>Annuler</DialogClose>
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
