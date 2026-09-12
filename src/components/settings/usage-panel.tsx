import { ShoppingCart, Users, Warehouse, Check, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UsageMetricCard } from "./usage-metric-card";
import { UpgradeRequestButton } from "./upgrade-request-button";
import { formatCurrency, formatPeriodLabel } from "@/lib/format";
import { FEATURE_KEY_LABELS, type PlanFeatures } from "@/lib/entitlements/catalogue";
import type { TenantUsage } from "@/lib/entitlements/usage";
import type { Plan, SubscriptionStatus } from "@prisma/client";

/**
 * "Paramètres → Abonnement & Utilisation" — the client-facing usage
 * dashboard (docs/adr/0035 "Client usage dashboard"). Written for a
 * Moroccan e-commerce business owner, not a developer: plain French
 * sentences, no "quota"/"tenant"/technical jargon, reassuring tone (see
 * that ADR's "Important product rule"). Read-only except the
 * upgrade-request button — a tenant can never change its own plan or
 * limits (docs/adr/0035 "Platform plan control").
 */
export function UsagePanel({
  plan,
  subscriptionStatus,
  features,
  usage,
  canRequestUpgrade,
}: {
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  features: PlanFeatures;
  usage: TenantUsage;
  canRequestUpgrade: boolean;
}) {
  const isPro = plan.code === "PRO";
  const mostSevere = [usage.orders.status, usage.users.status, usage.warehouses.status].includes("LIMIT_REACHED")
    ? "LIMIT_REACHED"
    : [usage.orders.status, usage.users.status, usage.warehouses.status].includes("CRITICAL")
      ? "CRITICAL"
      : [usage.orders.status, usage.users.status, usage.warehouses.status].includes("WARNING")
        ? "WARNING"
        : "NORMAL";

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {/* Plan summary */}
      <Card>
        <CardContent className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">Forfait actuel</p>
            <div className="mt-1 flex items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-tight">{plan.name}</h2>
              {subscriptionStatus === "PAST_DUE" && <Badge variant="destructive">Paiement en retard</Badge>}
              {subscriptionStatus === "TRIALING" && <Badge variant="secondary">Essai</Badge>}
              {subscriptionStatus === "CANCELED" && <Badge variant="outline">Résilié</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatCurrency(plan.monthlyPriceMad.toString())} / mois
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-sm text-muted-foreground">Période en cours</p>
            <p className="font-medium capitalize">{formatPeriodLabel(usage.period)}</p>
          </div>
        </CardContent>
      </Card>

      {/* Utilisation */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Utilisation de votre abonnement</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <UsageMetricCard label="Commandes ce mois-ci" icon={ShoppingCart} used={usage.orders.used} limit={usage.orders.limit} status={usage.orders.status} unit="commandes" />
          <UsageMetricCard label="Utilisateurs" icon={Users} used={usage.users.used} limit={usage.users.limit} status={usage.users.status} unit="utilisateurs" />
          <UsageMetricCard label="Entrepôts" icon={Warehouse} used={usage.warehouses.used} limit={usage.warehouses.limit} status={usage.warehouses.status} unit="entrepôts" />
        </div>
        {usage.storage === null && (
          <p className="mt-2 text-xs text-muted-foreground">Stockage de fichiers : non applicable sur ce forfait.</p>
        )}
      </div>

      {/* Upgrade nudge — only shown when it's actually relevant */}
      {!isPro && mostSevere !== "NORMAL" && canRequestUpgrade && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">Votre activité augmente rapidement.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Vous avez utilisé {usage.orders.percent ?? 0}% de votre quota mensuel de commandes. Le forfait PRO vous
                permet de gérer jusqu&apos;à environ 7 000 commandes par mois, avec 20 utilisateurs et 10 entrepôts.
              </p>
            </div>
            <UpgradeRequestButton requestedPlanCode="PRO" label="Voir le forfait PRO" />
          </CardContent>
        </Card>
      )}

      {/* Fonctionnalités incluses */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Fonctionnalités incluses</h3>
        <Card>
          <CardContent className="grid gap-2.5 pt-5 sm:grid-cols-2">
            {(Object.keys(FEATURE_KEY_LABELS) as (keyof typeof FEATURE_KEY_LABELS)[]).map((key) => {
              const label = FEATURE_KEY_LABELS[key]!;
              const value = features[key];
              const on = value === true || value === "standard" || value === "advanced";
              const tierSuffix = value === "advanced" ? " (avancé)" : value === "standard" ? "" : "";
              return (
                <div key={key} className="flex items-center gap-2 text-sm">
                  {on ? <Check className="size-4 text-emerald-600 dark:text-emerald-400" /> : <X className="size-4 text-muted-foreground" />}
                  <span className={on ? "" : "text-muted-foreground"}>
                    {label}
                    {tierSuffix}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>

      {!isPro && canRequestUpgrade && mostSevere === "NORMAL" && (
        <div>
          <UpgradeRequestButton requestedPlanCode="PRO" label="Passer à PRO" />
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Pour toute question sur votre forfait ou votre facturation, utilisez le centre d&apos;aide (icône en bas à
        droite). Aucun paiement en ligne n&apos;est traité automatiquement par cette application aujourd&apos;hui —
        une demande de mise à niveau est transmise à notre équipe, qui vous recontacte pour finaliser le changement.
      </p>
    </div>
  );
}
