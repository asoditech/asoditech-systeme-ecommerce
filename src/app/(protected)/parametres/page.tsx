import { PageHeader } from "@/components/page-header";
import { BusinessSettingsForm } from "@/components/settings/business-settings-form";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Paramètres — ASODITECH Gestion E-commerce" };

export default async function ParametresPage() {
  const user = await requirePermission("settings.view");
  const canManage = hasPermission(user.role, "settings.manage");

  const settings = await prisma.businessSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });

  return (
    <div>
      <PageHeader title="Paramètres" description="Informations de l'entreprise et préférences générales." />
      <div className="max-w-2xl">
        {canManage ? (
          <BusinessSettingsForm settings={settings} />
        ) : (
          <p className="text-sm text-muted-foreground">Vous n&apos;avez pas la permission de modifier les paramètres.</p>
        )}
      </div>
    </div>
  );
}
