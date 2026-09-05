"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  testShopifyConnectionAction,
  syncShopifyProductsAction,
  syncShopifyOrdersAction,
  pushShopifyStockAction,
} from "@/actions/shopify";
import { disconnectIntegrationAction } from "@/actions/integrations";
import { Button } from "@/components/ui/button";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import type { SyncSummary } from "@/lib/integrations/shopify/sync";

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

// See the matching comment in woocommerce-actions.tsx: the orders sync
// does a small bounded amount of work per call and reports `hasMore`
// while the backlog isn't finished, so the button re-invokes it itself
// instead of making the operator click repeatedly.
const MAX_SYNC_ITERATIONS = 80;
const SYNC_ITERATION_GAP_MS = 250;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ShopifyActions({ canManage, hasCredentials }: { canManage: boolean; hasCredentials: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [showWebhookInfo, setShowWebhookInfo] = useState(false);

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

  // Shared by orders and products: both syncs are capped per call and
  // report `hasMore` while their backlog/catalog isn't finished, so the
  // button re-invokes the action itself instead of making the operator
  // click repeatedly for a large one.
  function runLoopedSync(
    busyKey: string,
    toastId: string,
    label: string,
    action: () => Promise<{ ok: boolean; error?: string; data?: { summary: SyncSummary } }>
  ) {
    setBusy(busyKey);
    startTransition(async () => {
      const totals = { imported: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
      toast.loading(`Synchronisation ${label}...`, { id: toastId });
      try {
        for (let i = 0; i < MAX_SYNC_ITERATIONS; i++) {
          const result = await action();
          if (!result.ok || !result.data) {
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
          toast.warning(`${label} : ${summaryText(totals)}.`, { id: toastId });
        } else {
          toast.success(`${label} : ${summaryText(totals)}.`, { id: toastId });
        }
      } catch {
        toast.error("L'opération a échoué ou expiré. Réessayez.", { id: toastId });
      } finally {
        setBusy(null);
        router.refresh();
      }
    });
  }

  function runOrdersSync() {
    runLoopedSync("orders", "shopify-orders-sync", "Commandes", syncShopifyOrdersAction);
  }

  function runProductsSync() {
    runLoopedSync("products", "shopify-products-sync", "Produits", syncShopifyProductsAction);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() =>
            run("test", async () => {
              const result = await testShopifyConnectionAction();
              if (result.ok) toast.success("Connexion vérifiée avec succès.");
              return result;
            })
          }
        >
          {busy === "test" ? "Test en cours..." : "Tester la connexion"}
        </Button>

        <Button type="button" size="sm" variant="outline" disabled={isPending} onClick={runProductsSync}>
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
              const result = await pushShopifyStockAction();
              if (result.ok) summaryToast("Stock envoyé", result.data.summary);
              return result;
            })
          }
        >
          {busy === "stock" ? "Envoi en cours..." : "Pousser le stock"}
        </Button>

        <Button type="button" size="sm" variant="outline" onClick={() => setShowWebhookInfo((v) => !v)}>
          Configurer les webhooks
        </Button>

        <ConfirmActionButton
          label="Se déconnecter"
          variant="ghost"
          title="Déconnecter Shopify ?"
          description="Les identifiants stockés seront supprimés. Les données déjà synchronisées restent en place."
          hiddenFields={{ provider: "SHOPIFY" }}
          action={disconnectIntegrationAction}
          successMessage="Intégration Shopify déconnectée."
          destructive
        />
      </div>

      {showWebhookInfo && (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
          <p>
            Dans Shopify (application personnalisée → Configuration API → Webhooks, ou Notifications), créez
            des abonnements webhook vers l&apos;URL ci-dessous pour les sujets « Commande créée », « Commande
            mise à jour », « Commande annulée » et « Remboursement créé ». Le secret de signature est le
            « Client secret » de l&apos;application — celui saisi comme secret API lors de la configuration.
          </p>
          <code className="block break-all rounded bg-background p-2">
            {typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/shopify` : "/api/webhooks/shopify"}
          </code>
        </div>
      )}
    </div>
  );
}
