"use client";

import { Calculator } from "lucide-react";
import { updateCostingMethodAction } from "@/actions/settings";
import { ChoiceCard, ValueTile } from "@/components/settings/setting-controls";
import { COSTING_METHOD_HELP, COSTING_METHOD_LABELS } from "@/lib/settings/configuration-model";
import type { BusinessSettings, CostingMethod } from "@prisma/client";

/**
 * Product costing: how a validated reception updates a product's CURRENT
 * cost. The existing action (`updateCostingMethodAction`), as a value tile
 * whose editor offers the three methods as cards.
 */
export function CostingMethodForm({ settings }: { settings: Pick<BusinessSettings, "costingMethod"> }) {
  return (
    <ValueTile
      anchor="methode-cout"
      section="stock"
      icon={Calculator}
      title="Méthode de calcul du coût"
      summary="Comment une réception validée met à jour le coût actuel d'un produit."
      value={COSTING_METHOD_LABELS[settings.costingMethod]}
      valueCaption={COSTING_METHOD_HELP[settings.costingMethod]}
      note="Jamais le coût déjà figé sur une commande ou une vente passée."
      action={updateCostingMethodAction}
      success="Méthode de calcul du coût enregistrée."
    >
      <div role="radiogroup" aria-label="Méthode de calcul du coût" className="grid gap-2">
        {(Object.keys(COSTING_METHOD_LABELS) as CostingMethod[]).map((m) => (
          <ChoiceCard
            key={m}
            name="costingMethod"
            value={m}
            defaultChecked={m === settings.costingMethod}
            title={COSTING_METHOD_LABELS[m]}
            description={COSTING_METHOD_HELP[m]}
          />
        ))}
      </div>
    </ValueTile>
  );
}
