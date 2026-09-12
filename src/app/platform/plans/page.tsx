import { PageHeader } from "@/components/page-header";
import { PlanEditForm } from "@/components/platform/plan-edit-form";
import { listOfferedPlans } from "@/lib/entitlements/plan";
import { parsePlanFeatures } from "@/lib/entitlements/catalogue";

export const metadata = { title: "Forfaits — ASODITECH Gestion E-commerce" };

/**
 * `/platform/plans` — the centralized plan/entitlement definition
 * (docs/adr/0035). Only BUSINESS and PRO are ever shown here —
 * `listOfferedPlans()` deliberately excludes CUSTOM, reserved for a
 * future enterprise plan that is not exposed or assignable anywhere in
 * this phase, per the brief.
 */
export default async function PlatformPlansPage() {
  const plans = await listOfferedPlans();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Forfaits"
        description="Prix, limites et fonctionnalités des forfaits commerciaux. Toute modification s'applique immédiatement à chaque tenant sur ce forfait."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {plans.map((plan) => (
          <PlanEditForm key={plan.id} plan={plan} features={parsePlanFeatures(plan.features)} />
        ))}
      </div>
    </div>
  );
}
