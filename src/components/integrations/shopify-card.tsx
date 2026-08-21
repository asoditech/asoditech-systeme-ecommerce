import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConnectIntegrationDialog } from "@/components/integrations/connect-integration-dialog";
import { ShopifyActions } from "@/components/integrations/shopify-actions";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";
import { INTEGRATION_STATUS_LABELS } from "@/lib/status-labels";
import type { SyncRun } from "@prisma/client";

const RESOURCE_LABELS: Record<string, { label: string; direction: string }> = {
  EMPLACEMENTS: { label: "Emplacements", direction: "Shopify → Système" },
  PRODUITS: { label: "Produits (dont variantes et stock)", direction: "Shopify → Système" },
  COMMANDES: { label: "Commandes (dont clients)", direction: "Shopify → Système" },
  STOCK_ENVOI: { label: "Stock", direction: "Système → Shopify" },
};

const SYNC_RUN_STATUS_LABELS: Record<string, string> = {
  EN_COURS: "En cours",
  SUCCES: "Succès",
  ECHEC: "Échec",
  PARTIEL: "Partiel",
};

function summaryLine(run: SyncRun): string {
  const parts = [
    run.itemsImported > 0 && `${run.itemsImported} importé(s)`,
    run.itemsUpdated > 0 && `${run.itemsUpdated} mis à jour`,
    run.itemsUnchanged > 0 && `${run.itemsUnchanged} inchangé(s)`,
    run.itemsSkipped > 0 && `${run.itemsSkipped} ignoré(s)`,
    run.itemsFailed > 0 && `${run.itemsFailed} échoué(s)`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "aucun élément traité";
}

export async function ShopifyCard({ canManage }: { canManage: boolean }) {
  const integration = await prisma.integration.findUnique({ where: { provider: "SHOPIFY" } });
  const runs = integration
    ? await prisma.syncRun.findMany({
        where: { integrationId: integration.id },
        distinct: ["resource"],
        orderBy: { startedAt: "desc" },
      })
    : [];

  const status = integration?.status ?? "DECONNECTE";
  const meta = INTEGRATION_STATUS_LABELS[status];
  const config = (integration?.config as { shopDomain?: string } | null) ?? null;
  const hasCredentials = Boolean(integration?.credentialsEncrypted);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="text-base">Shopify</CardTitle>
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {config?.shopDomain && <p className="text-xs text-muted-foreground">Boutique : {config.shopDomain}</p>}

        {integration?.lastError && status === "ERREUR" && (
          <p className="text-xs text-destructive">{integration.lastError}</p>
        )}

        {integration?.lastConnectionCheckAt && (
          <p className="text-xs text-muted-foreground">
            Dernière vérification : {formatDateTime(integration.lastConnectionCheckAt)}
          </p>
        )}

        <div className="space-y-1.5">
          {(["EMPLACEMENTS", "PRODUITS", "COMMANDES", "STOCK_ENVOI"] as const).map((resource) => {
            const run = runs.find((r) => r.resource === resource);
            const info = RESOURCE_LABELS[resource];
            return (
              <div key={resource} className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">
                  {info.label} <span className="text-muted-foreground/70">({info.direction})</span>
                </span>
                {run ? (
                  <span title={summaryLine(run)}>
                    {SYNC_RUN_STATUS_LABELS[run.status]} · {formatDateTime(run.startedAt)}
                  </span>
                ) : (
                  <span className="text-muted-foreground/70">Jamais synchronisé</span>
                )}
              </div>
            );
          })}
        </div>

        {canManage && (
          <div className="space-y-2 pt-1">
            <ConnectIntegrationDialog provider="SHOPIFY" label="Shopify" />
            <ShopifyActions canManage={canManage} hasCredentials={hasCredentials} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
