import { Globe, Clock, AlertCircle, Tags, Package, ShoppingCart, Boxes } from "lucide-react";
import { Notice } from "@/components/ui/notice";
import { BrandTile } from "@/components/brand-logo";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectIntegrationDialog } from "@/components/integrations/connect-integration-dialog";
import { WooCommerceActions } from "@/components/integrations/woocommerce-actions";
import { ConnectionStatusPill } from "@/components/integrations/connection-status-pill";
import { SyncResourceRow } from "@/components/integrations/sync-resource-row";
import { ForceNouvelleToggle } from "@/components/integrations/force-nouvelle-toggle";
import { ImportHistoryToggle } from "@/components/integrations/import-history-toggle";
import { WooCommerceStoreSettings } from "@/components/integrations/woocommerce-store-settings";
import { inventoryOwnerOf, remoteDeletionModeOf } from "@/lib/integrations/woocommerce/store-settings";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";
import { webhookFailureMessage, webhookFailureSince } from "@/lib/integrations/shared/webhook-health";

const RESOURCES = [
  { key: "CATEGORIES", icon: Tags, label: "Catégories", direction: "WooCommerce → Système" },
  { key: "PRODUITS", icon: Package, label: "Produits (dont variations et stock)", direction: "WooCommerce → Système" },
  { key: "COMMANDES", icon: ShoppingCart, label: "Commandes (dont clients)", direction: "WooCommerce → Système" },
  { key: "STOCK_ENVOI", icon: Boxes, label: "Stock", direction: "Système → WooCommerce" },
] as const;

export async function WooCommerceCard({ canManage }: { canManage: boolean }) {
  const integration = await prisma.integration.findFirst({ where: { provider: "WOOCOMMERCE" } });
  const runs = integration
    ? await prisma.syncRun.findMany({
        where: { integrationId: integration.id },
        distinct: ["resource"],
        orderBy: { startedAt: "desc" },
      })
    : [];
  const lastWebhook = integration
    ? await prisma.webhookEvent.findFirst({
        where: { integrationId: integration.id },
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true, topic: true },
      })
    : null;
  const failureWhere = integration
    ? { integrationId: integration.id, status: "ECHEC", receivedAt: { gte: webhookFailureSince() } }
    : null;
  const [failedWebhooks, lastFailedWebhook] = failureWhere
    ? await Promise.all([
        prisma.webhookEvent.count({ where: failureWhere }),
        prisma.webhookEvent.findFirst({ where: failureWhere, orderBy: { receivedAt: "desc" }, select: { receivedAt: true, topic: true } }),
      ])
    : [0, null];
  const webhookFailure = webhookFailureMessage(failedWebhooks, lastFailedWebhook, formatDateTime);

  const status = integration?.status ?? "DECONNECTE";
  const config = (integration?.config as { siteUrl?: string; forceNouvelleOnImport?: boolean; importHistoricalOrders?: boolean; historyCutoffAt?: unknown } | null) ?? null;
  const hasCredentials = Boolean(integration?.credentialsEncrypted);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BrandTile brand="woocommerce" label="WooCommerce" />
          <div>
            <CardTitle>WooCommerce</CardTitle>
            <ConnectionStatusPill status={status} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {config?.siteUrl && (
          <div className="flex items-center gap-1.5 truncate rounded-xl bg-pill-neutral px-2.5 py-1.5 text-xs text-muted-foreground">
            <Globe className="size-3.5 shrink-0" />
            <span className="truncate">{config.siteUrl}</span>
          </div>
        )}

        {integration?.lastError && status === "ERREUR" && (
          <div className="flex items-start gap-2 rounded-tile bg-pill-red px-3 py-2 text-xs text-pill-red-fg">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <p>{integration.lastError}</p>
          </div>
        )}

        {integration?.lastConnectionCheckAt && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5 shrink-0" />
            Dernière vérification : {formatDateTime(integration.lastConnectionCheckAt)}
          </div>
        )}

        {hasCredentials && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5 shrink-0" />
            {lastWebhook
              ? `Dernier webhook reçu : ${formatDateTime(lastWebhook.receivedAt)} (${lastWebhook.topic})`
              : "Aucun webhook reçu — les commandes n'arrivent en temps réel que si les webhooks sont enregistrés dans WooCommerce."}
          </div>
        )}

        {webhookFailure && (
          <Notice tone="warning" size="sm" className="gap-2">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <p>{webhookFailure}</p>
          </Notice>
        )}

        <div className="divide-y divide-hairline rounded-lg border border-hairline px-3">
          {RESOURCES.map((resource) => (
            <SyncResourceRow
              key={resource.key}
              icon={resource.icon}
              label={resource.label}
              direction={resource.direction}
              run={runs.find((r) => r.resource === resource.key)}
            />
          ))}
        </div>

        {canManage && hasCredentials && (
          <>
            <ForceNouvelleToggle provider="WOOCOMMERCE" checked={config?.forceNouvelleOnImport !== false} />
            <ImportHistoryToggle
              provider="WOOCOMMERCE"
              checked={config?.importHistoricalOrders !== false}
              cutoff={typeof config?.historyCutoffAt === "string" ? config.historyCutoffAt : null}
            />
            <WooCommerceStoreSettings remoteDeletionMode={remoteDeletionModeOf(config)} inventoryOwner={inventoryOwnerOf(config)} />
          </>
        )}
      </CardContent>

      {canManage && (
        <CardFooter className="flex flex-wrap items-center gap-2">
          <ConnectIntegrationDialog provider="WOOCOMMERCE" label="WooCommerce" />
          <WooCommerceActions canManage={canManage} hasCredentials={hasCredentials} />
        </CardFooter>
      )}
    </Card>
  );
}
