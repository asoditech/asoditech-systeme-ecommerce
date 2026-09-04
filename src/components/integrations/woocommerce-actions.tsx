"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  testWooCommerceConnectionAction,
  syncWooCommerceProductsAction,
  syncWooCommerceOrdersAction,
  pushWooCommerceStockAction,
  generateWooCommerceWebhookSecretAction,
} from "@/actions/woocommerce";
import { disconnectIntegrationAction } from "@/actions/integrations";
import { Button } from "@/components/ui/button";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SyncSummary } from "@/lib/integrations/woocommerce/sync";

function summaryText(summary: Pick<SyncSummary, "imported" | "updated" | "unchanged" | "skipped" | "failed">) {
  const parts = [
    summary.imported > 0 && `${summary.imported} importé(s)`,
    summary.updated > 0 && `${summary.updated} mis à jour`,
    summary.unchanged > 0 && `${summary.unchanged} inchangé(s)`,
    summary.skipped > 0 && `${summary.skipped} ignoré(s)`,
    summary.failed > 0 && `${summary.failed} échoué(s)`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "aucun élément";
}

function summaryToast(label: string, summary: SyncSummary) {
  if (summary.failed > 0) {
    toast.warning(`${label} : ${summaryText(summary)}.`);
  } else {
    toast.success(`${label} : ${summaryText(summary)}.`);
  }
}

// The orders sync does at most a small amount of work per call (sized for
// Vercel Hobby's ~10s function limit — see syncOrders' own doc comment)
// and reports `hasMore` when there's more of the backlog left. Rather than
// making the operator click "Synchroniser les commandes" over and over for
// a large first import, the button re-invokes the action itself while
// hasMore stays true, so one click looks like one sync even though it is
// really several short runs — with a safety cap so a bug can't spin forever.
const MAX_SYNC_ITERATIONS = 80;
const SYNC_ITERATION_GAP_MS = 250;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function WooCommerceActions({ canManage, hasCredentials }: { canManage: boolean; hasCredentials: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [webhookDialog, setWebhookDialog] = useState<{ secret: string; url: string } | null>(null);

  if (!canManage) return null;
  if (!hasCredentials) {
    return <p className="text-xs text-muted-foreground">Configurez la connexion pour activer ces actions.</p>;
  }

  function run(name: string, action: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) {
    setBusy(name);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          toast.error(result.error ?? "Une erreur est survenue.");
        }
      } catch {
        // A thrown action (timeout, aborted request, unexpected server
        // error) must surface as a toast, not crash the whole page into
        // the error boundary.
        toast.error("L'opération a échoué ou expiré. Réessayez.");
      } finally {
        setBusy(null);
        router.refresh();
      }
    });
  }

  function runOrdersSync() {
    setBusy("orders");
    const toastId = "woo-orders-sync";
    startTransition(async () => {
      const totals = { imported: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
      toast.loading("Synchronisation des commandes...", { id: toastId });
      try {
        for (let i = 0; i < MAX_SYNC_ITERATIONS; i++) {
          const result = await syncWooCommerceOrdersAction();
          if (!result.ok) {
            toast.error(result.error ?? "Une erreur est survenue.", { id: toastId });
            return;
          }
          const s = result.data.summary;
          totals.imported += s.imported;
          totals.updated += s.updated;
          totals.unchanged += s.unchanged;
          totals.skipped += s.skipped;
          totals.failed += s.failed;
          if (!s.hasMore) break;
          toast.loading(`Synchronisation en cours... ${summaryText(totals)}.`, { id: toastId });
          await sleep(SYNC_ITERATION_GAP_MS);
        }
        if (totals.failed > 0) {
          toast.warning(`Commandes : ${summaryText(totals)}.`, { id: toastId });
        } else {
          toast.success(`Commandes : ${summaryText(totals)}.`, { id: toastId });
        }
      } catch {
        toast.error("L'opération a échoué ou expiré. Réessayez.", { id: toastId });
      } finally {
        setBusy(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() =>
          run("test", async () => {
            const result = await testWooCommerceConnectionAction();
            if (result.ok) toast.success("Connexion vérifiée avec succès.");
            return result;
          })
        }
      >
        {busy === "test" ? "Test en cours..." : "Tester la connexion"}
      </Button>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() =>
          run("products", async () => {
            const result = await syncWooCommerceProductsAction();
            if (result.ok) summaryToast("Produits", result.data.summary);
            return result;
          })
        }
      >
        {busy === "products" ? "Synchronisation..." : "Synchroniser les produits"}
      </Button>

      <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={runOrdersSync}>
        {busy === "orders" ? "Synchronisation..." : "Synchroniser les commandes"}
      </Button>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() =>
          run("stock", async () => {
            const result = await pushWooCommerceStockAction();
            if (result.ok) summaryToast("Stock envoyé", result.data.summary);
            return result;
          })
        }
      >
        {busy === "stock" ? "Envoi en cours..." : "Pousser le stock"}
      </Button>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isPending}
        onClick={() =>
          run("webhook", async () => {
            const result = await generateWooCommerceWebhookSecretAction();
            if (result.ok) {
              setWebhookDialog({
                secret: result.data.secret,
                url: `${window.location.origin}/api/webhooks/woocommerce`,
              });
            }
            return result;
          })
        }
      >
        {busy === "webhook" ? "Génération..." : "Générer un secret webhook"}
      </Button>

      <ConfirmActionButton
        label="Se déconnecter"
        variant="ghost"
        title="Déconnecter WooCommerce ?"
        description="Les identifiants stockés seront supprimés. Les données déjà synchronisées restent en place."
        hiddenFields={{ provider: "WOOCOMMERCE" }}
        action={disconnectIntegrationAction}
        successMessage="Intégration WooCommerce déconnectée."
        destructive
      />

      <Dialog open={webhookDialog !== null} onOpenChange={(open) => !open && setWebhookDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Secret webhook généré</DialogTitle>
            <DialogDescription>
              Ce secret ne sera plus jamais affiché. Copiez-le maintenant et configurez un webhook dans
              WooCommerce (Réglages → Avancé → Webhooks) avec l&apos;URL et le secret ci-dessous, pour les
              sujets « Commande créée » et « Commande mise à jour ».
            </DialogDescription>
          </DialogHeader>
          {webhookDialog && (
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground">URL de livraison</p>
                <code className="block break-all rounded bg-muted p-2 text-xs">{webhookDialog.url}</code>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Secret</p>
                <code className="block break-all rounded bg-muted p-2 text-xs">{webhookDialog.secret}</code>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" onClick={() => setWebhookDialog(null)}>
              J&apos;ai copié le secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
