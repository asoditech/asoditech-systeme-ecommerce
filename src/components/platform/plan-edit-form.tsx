"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updatePlanAction } from "@/actions/plans";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PlanFeatures, TieredFeatureKey } from "@/lib/entitlements/catalogue";
import { FEATURE_KEY_LABELS, TIERED_FEATURE_KEYS } from "@/lib/entitlements/catalogue";
import type { Plan } from "@prisma/client";

const TIER_LABEL: Record<string, string> = { standard: "Standard", advanced: "Avancé" };

/**
 * `/platform/plans` editor — the centralized place prices/limits/features
 * are declared (docs/adr/0035 "Central entitlements system"). Changing a
 * value here changes it for EVERY tenant currently on this plan,
 * immediately — there is no per-tenant override, which the confirmation
 * copy below says plainly. Limit fields empty = unlimited (reserved for a
 * future CUSTOM plan; never left empty for Business/Pro in practice).
 */
export function PlanEditForm({ plan, features }: { plan: Plan; features: PlanFeatures }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState(plan.name);
  const [installationPrice, setInstallationPrice] = useState(plan.installationPriceMad.toString());
  const [monthlyPrice, setMonthlyPrice] = useState(plan.monthlyPriceMad.toString());
  const [maxOrders, setMaxOrders] = useState(plan.maxOrdersPerMonth?.toString() ?? "");
  const [maxUsers, setMaxUsers] = useState(plan.maxUsers?.toString() ?? "");
  const [maxWarehouses, setMaxWarehouses] = useState(plan.maxWarehouses?.toString() ?? "");
  const [tiers, setTiers] = useState<Record<TieredFeatureKey, "standard" | "advanced">>({
    reports: features.reports,
    profitability: features.profitability,
    backup: features.backup,
  });
  const [booleanFeatures, setBooleanFeatures] = useState({
    woocommerce: features.woocommerce,
    shopify: features.shopify,
    aiAssistant: features.aiAssistant,
    commissions: features.commissions,
    finance: features.finance,
  });

  function save() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("planId", plan.id);
      formData.set("name", name);
      formData.set("installationPriceMad", installationPrice);
      formData.set("monthlyPriceMad", monthlyPrice);
      formData.set("maxOrdersPerMonth", maxOrders);
      formData.set("maxUsers", maxUsers);
      formData.set("maxWarehouses", maxWarehouses);
      formData.set(
        "features",
        JSON.stringify({
          orders: true,
          users: true,
          warehouses: true,
          integrations: true,
          notifications: true,
          support: plan.code === "PRO" ? "priority" : "standard",
          ...booleanFeatures,
          ...tiers,
        })
      );
      const result = await updatePlanAction(formData);
      if (result.ok) {
        toast.success("Forfait mis à jour.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-6 rounded-lg border bg-background p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        <Button type="button" onClick={save} disabled={isPending}>
          Enregistrer
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Nom affiché</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div />
        <div className="space-y-1.5">
          <Label>Frais d&apos;installation (MAD, unique)</Label>
          <Input type="number" min={0} step="0.01" value={installationPrice} onChange={(e) => setInstallationPrice(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Abonnement mensuel (MAD)</Label>
          <Input type="number" min={0} step="0.01" value={monthlyPrice} onChange={(e) => setMonthlyPrice(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Commandes / mois (vide = illimité)</Label>
          <Input type="number" min={1} value={maxOrders} onChange={(e) => setMaxOrders(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Utilisateurs actifs max. (vide = illimité)</Label>
          <Input type="number" min={1} value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Entrepôts actifs max. (vide = illimité)</Label>
          <Input type="number" min={1} value={maxWarehouses} onChange={(e) => setMaxWarehouses(e.target.value)} />
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">Niveau des fonctionnalités</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {TIERED_FEATURE_KEYS.map((key) => (
            <div key={key} className="space-y-1.5">
              <Label>{FEATURE_KEY_LABELS[key]}</Label>
              <Select value={tiers[key]} onValueChange={(v) => v && setTiers((t) => ({ ...t, [key]: v as "standard" | "advanced" }))}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(value: string) => TIER_LABEL[value] ?? value}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="advanced">Avancé</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium">Intégrations & modules</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(Object.keys(booleanFeatures) as (keyof typeof booleanFeatures)[]).map((key) => (
            <label key={key} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              {FEATURE_KEY_LABELS[key] ?? key}
              <Switch
                checked={booleanFeatures[key]}
                onCheckedChange={(checked) => setBooleanFeatures((f) => ({ ...f, [key]: checked }))}
              />
            </label>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Toute modification s&apos;applique immédiatement à tous les tenants actuellement sur ce forfait — il
        n&apos;existe pas de dérogation par tenant.
      </p>
    </div>
  );
}
