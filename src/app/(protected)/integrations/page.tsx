import { Plug, Megaphone, Target, Music2, MessageCircle, Mail, FileSpreadsheet, Bot, Clock3, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { WooCommerceCard } from "@/components/integrations/woocommerce-card";
import { ShopifyCard } from "@/components/integrations/shopify-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { INTEGRATION_PROVIDER_LABELS } from "@/lib/status-labels";
import type { IntegrationProvider } from "@prisma/client";

export const metadata = { title: "Intégrations — ASODITECH Gestion E-commerce" };

// Everything here is roadmap-only in this phase — no connection flow, no
// credentials, nothing to configure yet. See
// docs/adr/0004-integration-architecture.md. WooCommerce/Shopify (the two
// providers with a real adapter) get their own dedicated cards above,
// never this generic "planned" tile.
const PLANNED_PROVIDER_ICONS: Record<string, LucideIcon> = {
  META_ADS: Megaphone,
  GOOGLE_ADS: Target,
  TIKTOK_ADS: Music2,
  WHATSAPP: MessageCircle,
  EMAIL: Mail,
  GOOGLE_SHEETS: FileSpreadsheet,
  AI_PROVIDER: Bot,
};

export default async function IntegrationsPage() {
  const user = await requirePermission("integrations.view");
  const canManage = hasPermission(user.role, "integrations.manage");
  const integrations = await prisma.integration.findMany();

  const plannedRows = Object.entries(INTEGRATION_PROVIDER_LABELS).filter(
    ([provider]) => provider !== "WOOCOMMERCE" && provider !== "SHOPIFY"
  ) as [IntegrationProvider, string][];

  return (
    <div>
      <PageHeader
        title="Intégrations"
        description="État des connexions externes. WooCommerce et Shopify disposent d'un adaptateur de synchronisation réel ; les autres intégrations restent au stade de configuration/planification — voir docs/adr/0010-woocommerce-integration.md et docs/adr/0011-shopify-integration.md."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <WooCommerceCard canManage={canManage} />
        <ShopifyCard canManage={canManage} />
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">Sur la feuille de route</h2>
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <Clock3 className="size-3" />
            Bientôt disponible
          </Badge>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {plannedRows.map(([provider, label]) => {
            const Icon = PLANNED_PROVIDER_ICONS[provider] ?? Plug;
            return (
              <Card key={provider} className="border-dashed bg-muted/20 shadow-none">
                <CardHeader className="flex-row items-center gap-3 space-y-0">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Icon className="size-4.5" />
                  </div>
                  <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground/80">Intégration prévue — non encore disponible.</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
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
