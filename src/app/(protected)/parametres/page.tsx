import { PageHeader } from "@/components/page-header";
import { BusinessSettingsForm } from "@/components/settings/business-settings-form";
import { SettingsNav } from "@/components/settings/settings-nav";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Paramètres — ASODITECH Gestion E-commerce" };

export default async function ParametresPage() {
  const user = await requirePermission("settings.view");
  const canManage = hasPermission(user.role, "settings.manage");

  // Phase 3 (docs/adr/0025): tenant-scoped, not a global singleton.
  const settings = await prisma.businessSettings.upsert({
    where: { tenantId: user.tenantId },
    update: {},
    create: {},
  });

  return (
    <div>
      <PageHeader title="Paramètres" description="Informations de l'entreprise et préférences générales." />
      <div className="max-w-3xl">
        <SettingsNav canManage={canManage} />
        {canManage ? (
          <BusinessSettingsForm settings={settings} />
        ) : (
          <p className="text-sm text-muted-foreground">Vous n&apos;avez pas la permission de modifier les paramètres.</p>
        )}
      </div>
    </div>
  );
}
