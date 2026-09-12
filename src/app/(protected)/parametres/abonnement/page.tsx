import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { UsagePanel } from "@/components/settings/usage-panel";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getTenantPlan } from "@/lib/entitlements/plan";
import { getTenantUsage } from "@/lib/entitlements/usage";

export const metadata = { title: "Abonnement & Utilisation — ASODITECH Gestion E-commerce" };

/**
 * Paramètres → Abonnement & Utilisation (docs/adr/0035). Read-only for
 * every role that can view Paramètres — a tenant's plan/limits are never
 * editable here, only by a platform admin via /platform/plans. The
 * "demander une mise à niveau" action is gated `settings.manage`
 * (OWNER/ADMIN), matching every other billing-adjacent action in this app
 * (Sauvegarde is the same gate).
 */
export default async function AbonnementPage() {
  const user = await requirePermission("settings.view");
  const canManage = hasPermission(user.role, "settings.manage");

  const [{ plan, features, subscriptionStatus }, usage] = await Promise.all([
    getTenantPlan(user.tenantId),
    getTenantUsage(user.tenantId),
  ]);

  return (
    <div>
      <PageHeader
        title="Abonnement & Utilisation"
        description="Votre forfait actuel, votre utilisation ce mois-ci, et les fonctionnalités incluses."
      />
      <SettingsNav canManage={canManage} />
      <UsagePanel plan={plan} subscriptionStatus={subscriptionStatus} features={features} usage={usage} canRequestUpgrade={canManage} />
    </div>
  );
}
