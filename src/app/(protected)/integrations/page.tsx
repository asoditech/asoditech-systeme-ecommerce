import { Plug } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ConnectIntegrationDialog } from "@/components/integrations/connect-integration-dialog";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { disconnectIntegrationAction } from "@/actions/integrations";
import { formatDateTime } from "@/lib/format";
import { INTEGRATION_PROVIDER_LABELS, INTEGRATION_STATUS_LABELS } from "@/lib/status-labels";
import type { IntegrationProvider } from "@prisma/client";

export const metadata = { title: "Intégrations — ASODITECH Gestion E-commerce" };

// Providers with a real, configurable connection flow in this phase. The
// rest are shown as planned — see docs/adr/0004-integration-architecture.md.
const CONFIGURABLE_PROVIDERS: IntegrationProvider[] = ["WOOCOMMERCE", "SHOPIFY"];

export default async function IntegrationsPage() {
  const user = await requirePermission("integrations.view");
  const canManage = hasPermission(user.role, "integrations.manage");
  const integrations = await prisma.integration.findMany();

  const rows = Object.entries(INTEGRATION_PROVIDER_LABELS).map(([provider, label]) => ({
    provider: provider as IntegrationProvider,
    label,
    record: integrations.find((i) => i.provider === provider),
    configurable: CONFIGURABLE_PROVIDERS.includes(provider as IntegrationProvider),
  }));

  return (
    <div>
      <PageHeader
        title="Intégrations"
        description="État des connexions externes. WooCommerce et Shopify sont les premières intégrations prévues ; les adaptateurs de synchronisation seront livrés dans une phase ultérieure."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const status = row.record?.status ?? "DECONNECTE";
          const meta = INTEGRATION_STATUS_LABELS[status];
          return (
            <Card key={row.provider}>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="text-base">{row.label}</CardTitle>
                <Badge variant={meta.variant}>{meta.label}</Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                {row.record?.lastSyncAt ? (
                  <p className="text-xs text-muted-foreground">Dernière synchro : {formatDateTime(row.record.lastSyncAt)}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {row.configurable ? "Aucune synchronisation effectuée." : "Intégration prévue — non encore disponible."}
                  </p>
                )}
                {canManage && row.configurable && (
                  <div className="flex gap-2">
                    <ConnectIntegrationDialog provider={row.provider} label={row.label} />
                    {row.record?.status === "CONNECTE" && (
                      <ConfirmActionButton
                        label="Déconnecter"
                        variant="ghost"
                        title={`Déconnecter ${row.label} ?`}
                        description="Les identifiants stockés seront supprimés."
                        hiddenFields={{ provider: row.provider }}
                        action={disconnectIntegrationAction}
                        successMessage="Intégration déconnectée."
                        destructive
                      />
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {integrations.length === 0 && (
        <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Plug className="size-4" />
          Aucune intégration configurée pour le moment.
        </div>
      )}
    </div>
  );
}
