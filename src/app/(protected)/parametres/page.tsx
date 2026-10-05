import { PageHeader } from "@/components/page-header";
import { BusinessSettingsForm } from "@/components/settings/business-settings-form";
import { CostingMethodForm } from "@/components/settings/costing-method-form";
import { DefaultShippingProviderForm, SellerPriceOverrideForm } from "@/components/settings/sales-delivery-settings";
import { hasCapability } from "@/lib/auth/capabilities";
import { SettingsNav } from "@/components/settings/settings-nav";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Paramètres — ASODITECH Gestion E-commerce" };

export default async function ParametresPage() {
  const user = await requirePermission("settings.view");
  const canManage = userHasPermission(user, "settings.manage");

  // Phase 3 (docs/adr/0025): tenant-scoped, not a global singleton.
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: {},
    create: {},
  });
  const activeProviders = canManage
    ? await prisma.shippingProvider.findMany({
        where: { isActive: true },
        select: { id: true, name: true, capabilities: true },
        orderBy: { name: "asc" },
      })
    : [];

  return (
    <div>
      <PageHeader title="Paramètres" description="Informations de l'entreprise et préférences générales." />
      <div className="max-w-3xl">
        <SettingsNav canManage={canManage} canManageChannels={userHasPermission(user, "channels.manage")} />
        {canManage ? (
          <div className="space-y-5">
            <BusinessSettingsForm settings={settings} />
            <CostingMethodForm settings={settings} />
            {hasCapability(user, "offlineSales") && <SellerPriceOverrideForm enabled={settings.allowSellerPriceOverride} />}
            <DefaultShippingProviderForm
              providers={activeProviders.map((p) => ({ id: p.id, name: p.name, hasCityList: p.capabilities.includes("FETCH_CITIES") }))}
              defaultProviderId={settings.defaultShippingProviderId}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Vous n&apos;avez pas la permission de modifier les paramètres.</p>
        )}
      </div>
    </div>
  );
}
