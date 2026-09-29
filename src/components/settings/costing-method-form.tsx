"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Calculator } from "lucide-react";
import { updateCostingMethodAction } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { BusinessSettings, CostingMethod } from "@prisma/client";
import type { ActionResult } from "@/actions/types";

const COSTING_METHOD_LABELS: Record<CostingMethod, string> = {
  MANUAL: "Manuel",
  LAST_COST: "Dernier coût d'achat",
  WEIGHTED_AVERAGE: "Coût moyen pondéré",
};

const COSTING_METHOD_HELP: Record<CostingMethod, string> = {
  MANUAL: "Le coût est renseigné manuellement.",
  LAST_COST: "Le coût du produit est remplacé par le dernier coût d'achat validé.",
  WEIGHTED_AVERAGE: "Le coût est recalculé selon le stock existant et le nouveau coût d'achat.",
};

/**
 * Product costing (Phase 3 — Product Costing & Profitability input). A
 * small, standalone control, independently savable — same conventions as
 * BusinessSettingsForm (useActionState + useEffect for the toast/refresh,
 * French copy) but its own form/action so this one field doesn't ride on
 * the big company-info submit.
 */
export function CostingMethodForm({ settings }: { settings: Pick<BusinessSettings, "costingMethod"> }) {
  const router = useRouter();
  const [method, setMethod] = useState<CostingMethod>(settings.costingMethod);
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<BusinessSettings> | undefined, formData: FormData) =>
      updateCostingMethodAction(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success("Méthode de calcul du coût enregistrée.");
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
  }, [state, router]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Calculator className="size-4" />
          </span>
          Coûts & valorisation
        </CardTitle>
        <CardDescription>
          Détermine comment une réception validée met à jour le coût ACTUEL d&apos;un produit — utilisé pour la
          valorisation du stock et les rapports de rentabilité. N&apos;affecte jamais le coût déjà figé sur une
          commande ou une vente passée.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="costingMethod">Méthode de calcul du coût</Label>
            <Select name="costingMethod" value={method} onValueChange={(v) => v && setMethod(v as CostingMethod)}>
              <SelectTrigger id="costingMethod" className="w-full sm:w-80">
                <SelectValue>{(value: string) => COSTING_METHOD_LABELS[value as CostingMethod] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(COSTING_METHOD_LABELS) as CostingMethod[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {COSTING_METHOD_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{COSTING_METHOD_HELP[method]}</p>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
