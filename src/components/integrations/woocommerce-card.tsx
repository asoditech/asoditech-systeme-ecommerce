import { Store, Globe, Clock, AlertCircle, Tags, Package, ShoppingCart, Boxes } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConnectIntegrationDialog } from "@/components/integrations/connect-integration-dialog";
import { WooCommerceActions } from "@/components/integrations/woocommerce-actions";
import { ConnectionStatusPill } from "@/components/integrations/connection-status-pill";
import { SyncResourceRow } from "@/components/integrations/sync-resource-row";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/format";

const RESOURCES = [
  { key: "CATEGORIES", icon: Tags, label: "Catégories", direction: "WooCommerce → Système" },
  { key: "PRODUITS", icon: Package, label: "Produits (dont variations et stock)", direction: "WooCommerce → Système" },
  { key: "COMMANDES", icon: ShoppingCart, label: "Commandes (dont clients)", direction: "WooCommerce → Système" },
  { key: "STOCK_ENVOI", icon: Boxes, label: "Stock", direction: "Système → WooCommerce" },
] as const;

export async function WooCommerceCard({ canManage }: { canManage: boolean }) {
  const integration = await prisma.integration.findUnique({ where: { provider: "WOOCOMMERCE" } });
  const runs = integration
    ? await prisma.syncRun.findMany({
        where: { integrationId: integration.id },
        distinct: ["resource"],
        orderBy: { startedAt: "desc" },
      })
    : [];

  const status = integration?.status ?? "DECONNECTE";
  const config = (integration?.config as { siteUrl?: string } | null) ?? null;
  const hasCredentials = Boolean(integration?.credentialsEncrypted);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Store className="size-5" />
          </div>
          <div>
            <CardTitle>WooCommerce</CardTitle>
            <ConnectionStatusPill status={status} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {config?.siteUrl && (
          <div className="flex items-center gap-1.5 truncate rounded-md bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
            <Globe className="size-3.5 shrink-0" />
            <span className="truncate">{config.siteUrl}</span>
          </div>
        )}

        {integration?.lastError && status === "ERREUR" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/8 px-3 py-2 text-xs text-destructive">
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

        <div className="divide-y divide-border/60 rounded-lg border border-border/60 px-3">
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
