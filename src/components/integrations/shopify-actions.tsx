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

function summaryToast(label: string, summary: SyncSummary) {
  const parts = [
    summary.imported > 0 && `${summary.imported} importé(s)`,
    summary.updated > 0 && `${summary.updated} mis à jour`,
    summary.unchanged > 0 && `${summary.unchanged} inchangé(s)`,
    summary.skipped > 0 && `${summary.skipped} ignoré(s)`,
    summary.failed > 0 && `${summary.failed} échoué(s)`,
  ].filter(Boolean);
  const text = parts.length > 0 ? parts.join(", ") : "aucun élément";
  if (summary.failed > 0) {
    toast.warning(`${label} : ${text}.`);
  } else {
    toast.success(`${label} : ${text}.`);
  }
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

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() =>
            run("products", async () => {
              const result = await syncShopifyProductsAction();
              if (result.ok) summaryToast("Produits", result.data.summary);
              return result;
            })
          }
        >
          {busy === "products" ? "Synchronisation..." : "Synchroniser les produits"}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isPending}
          onClick={() =>
            run("orders", async () => {
              const result = await syncShopifyOrdersAction();
              if (result.ok) summaryToast("Commandes", result.data.summary);
              return result;
            })
          }
        >
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
