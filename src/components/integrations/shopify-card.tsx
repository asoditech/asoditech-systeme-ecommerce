import { Globe, Clock, AlertCircle, Warehouse, Package, ShoppingCart, Boxes } from "lucide-react";
import { BrandTile } from "@/components/brand-logo";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectIntegrationDialog } from "@/components/integrations/connect-integration-dialog";
import { ShopifyActions } from "@/components/integrations/shopify-actions";
import { ConnectionStatusPill } from "@/components/integrations/connection-status-pill";
import { SyncResourceRow } from "@/components/integrations/sync-resource-row";
import { ForceNouvelleToggle } from "@/components/integrations/force-nouvelle-toggle";
import { ImportHistoryToggle } from "@/components/integrations/import-history-toggle";
import { ShopifyStoreSettings } from "@/components/integrations/woocommerce-store-settings";
import { inventoryOwnerOf, remoteDeletionModeOf } from "@/lib/integrations/woocommerce/store-settings";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";

const RESOURCES = [
  { key: "EMPLACEMENTS", icon: Warehouse, label: "Emplacements", direction: "Shopify → Système" },
  { key: "PRODUITS", icon: Package, label: "Produits (dont variantes et stock)", direction: "Shopify → Système" },
  { key: "COMMANDES", icon: ShoppingCart, label: "Commandes (dont clients)", direction: "Shopify → Système — les statuts (confirmée, expédiée, livrée, annulée) ne sont pas renvoyés à Shopify" },
  { key: "STOCK_ENVOI", icon: Boxes, label: "Stock", direction: "Système → Shopify" },
] as const;

export async function ShopifyCard({ canManage }: { canManage: boolean }) {
  const integration = await prisma.integration.findFirst({ where: { provider: "SHOPIFY" } });
  const runs = integration
    ? await prisma.syncRun.findMany({
        where: { integrationId: integration.id },
        distinct: ["resource"],
        orderBy: { startedAt: "desc" },
      })
    : [];

  const status = integration?.status ?? "DECONNECTE";
  const config = (integration?.config as { shopDomain?: string; forceNouvelleOnImport?: boolean; importHistoricalOrders?: boolean; historyCutoffAt?: unknown } | null) ?? null;
  const hasCredentials = Boolean(integration?.credentialsEncrypted);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <BrandTile brand="shopify" label="Shopify" />
          <div>
            <CardTitle>Shopify</CardTitle>
            <ConnectionStatusPill status={status} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {config?.shopDomain && (
          <div className="flex items-center gap-1.5 truncate rounded-xl bg-pill-neutral px-2.5 py-1.5 text-xs text-muted-foreground">
            <Globe className="size-3.5 shrink-0" />
            <span className="truncate">{config.shopDomain}</span>
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
            <ForceNouvelleToggle provider="SHOPIFY" checked={config?.forceNouvelleOnImport !== false} />
            <ImportHistoryToggle
              provider="SHOPIFY"
              checked={config?.importHistoricalOrders !== false}
              cutoff={typeof config?.historyCutoffAt === "string" ? config.historyCutoffAt : null}
            />
            <ShopifyStoreSettings remoteDeletionMode={remoteDeletionModeOf(config)} inventoryOwner={inventoryOwnerOf(config)} />
          </>
        )}
      </CardContent>

      {canManage && (
        <CardFooter className="flex flex-wrap items-center gap-2">
          <ConnectIntegrationDialog provider="SHOPIFY" label="Shopify" />
          <ShopifyActions canManage={canManage} hasCredentials={hasCredentials} />
        </CardFooter>
      )}
    </Card>
  );
}
