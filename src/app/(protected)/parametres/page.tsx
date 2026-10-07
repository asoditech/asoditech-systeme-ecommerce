import { PageHeader } from "@/components/page-header";
import { ConfigurationView } from "@/components/settings/configuration-view";
import { resolveConfigSection } from "@/lib/settings/configuration-model";
import { hasCapability } from "@/lib/auth/capabilities";
import { SettingsNav } from "@/components/settings/settings-nav";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Paramètres — ASODITECH Gestion E-commerce" };

/** `forceNouvelleOnImport` is ON unless explicitly false (same rule as the Intégrations cards). */
function importsAsNouvelle(config: unknown): boolean {
  return (config as { forceNouvelleOnImport?: boolean } | null)?.forceNouvelleOnImport !== false;
}

export default async function ParametresPage({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const user = await requirePermission("settings.view");
  const section = resolveConfigSection((await searchParams).section);
  const canManage = userHasPermission(user, "settings.manage");

  // Phase 3 (docs/adr/0025): tenant-scoped, not a global singleton.
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: {},
    create: {},
  });
  const [activeProviders, integrations] = canManage
    ? await Promise.all([
        prisma.shippingProvider.findMany({
          where: { isActive: true },
          select: { id: true, name: true, capabilities: true },
          orderBy: { name: "asc" },
        }),
        prisma.integration.findMany({
          where: { provider: { in: ["WOOCOMMERCE", "SHOPIFY"] } },
          select: { provider: true, config: true },
        }),
      ])
    : [[], []];
  const woo = integrations.find((i) => i.provider === "WOOCOMMERCE");
  const shopify = integrations.find((i) => i.provider === "SHOPIFY");

  return (
    <div>
      <PageHeader
        title="Paramètres"
        description="Configuration de l'entreprise : informations, commandes, ventes magasin, stock, expédition et support."
      />
      <SettingsNav canManage={canManage} canManageChannels={userHasPermission(user, "channels.manage")} />
      {canManage ? (
        <ConfigurationView
          settings={settings}
          section={section}
          offlineSales={hasCapability(user, "offlineSales")}
          imports={{
            woocommerce: woo ? importsAsNouvelle(woo.config) : null,
            shopify: shopify ? importsAsNouvelle(shopify.config) : null,
          }}
          canManageIntegrations={userHasPermission(user, "integrations.manage")}
          canManageCost={userHasPermission(user, "finance.view")}
          providers={activeProviders.map((p) => ({ id: p.id, name: p.name, hasCityList: p.capabilities.includes("FETCH_CITIES") }))}
          links={{
            channels: userHasPermission(user, "channels.manage"),
            delivery: userHasPermission(user, "delivery.view"),
            warehouses: userHasPermission(user, "inventory.view"),
            integrations: userHasPermission(user, "integrations.view"),
            commissions: userHasPermission(user, "commissions.view"),
            backup: canManage,
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Vous n&apos;avez pas la permission de modifier les paramètres.</p>
      )}
    </div>
  );
}
