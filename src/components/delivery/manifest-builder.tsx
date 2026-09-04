"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileText } from "lucide-react";
import { generateDeliveryManifestAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, displayOrderNumber } from "@/lib/format";

export interface ManifestableShipment {
  id: string;
  trackingNumber: string | null;
  orderId: string;
  orderNumber: number;
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  externalNumber: string | null;
  customerName: string;
  cityLabel: string | null;
  cost: string | null;
  currency: string;
  providerId: string;
  providerName: string;
}

/**
 * Lets the operator pick a batch of EN_ATTENTE API shipments of ONE
 * provider and generate a carrier delivery note (Bon de Livraison) for
 * them. See docs/adr/0015-delivery-manifest.md. One "Générer" button per
 * provider group — a manifest never mixes carriers.
 */
export function ManifestBuilder({ shipments }: { shipments: ManifestableShipment[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const groups = useMemo(() => {
    const map = new Map<string, { providerName: string; items: ManifestableShipment[] }>();
    for (const s of shipments) {
      const g = map.get(s.providerId) ?? { providerName: s.providerName, items: [] };
      g.items.push(s);
      map.set(s.providerId, g);
    }
    return [...map.entries()].map(([providerId, g]) => ({ providerId, ...g }));
  }, [shipments]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(items: ManifestableShipment[], allSelected: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const s of items) {
        if (allSelected) next.delete(s.id);
        else next.add(s.id);
      }
      return next;
    });
  }

  function generate(providerId: string, items: ManifestableShipment[]) {
    const ids = items.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (ids.length === 0) {
      toast.error("Sélectionnez au moins une expédition.");
      return;
    }
    setPendingProviderId(providerId);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("providerId", providerId);
      fd.set("shipmentIds", ids.join(","));
      const result = await generateDeliveryManifestAction(fd);
      setPendingProviderId(null);
      if (result.ok) {
        toast.success("Bon de livraison créé.");
        setSelected((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (shipments.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="Aucun colis en attente de remise au transporteur."
        description="Les colis créés via un connecteur (statut « En attente ») apparaîtront ici pour être regroupés sur un bon de livraison."
      />
    );
  }

  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const allSelected = group.items.every((s) => selected.has(s.id));
        const selectedCount = group.items.filter((s) => selected.has(s.id)).length;
        return (
          <div key={group.providerId} className="rounded-lg border">
            <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
              <div className="flex items-center gap-2.5">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={() => toggleGroup(group.items, allSelected)}
                  aria-label={`Tout sélectionner — ${group.providerName}`}
                />
                <span className="text-sm font-medium">{group.providerName}</span>
                <span className="text-xs text-muted-foreground">
                  {selectedCount}/{group.items.length} sélectionné(s)
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                loading={isPending && pendingProviderId === group.providerId}
                disabled={selectedCount === 0 || (isPending && pendingProviderId !== group.providerId)}
                onClick={() => generate(group.providerId, group.items)}
              >
                Générer le bon de livraison
              </Button>
            </div>
            <ul className="divide-y">
              {group.items.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Checkbox
                    checked={selected.has(s.id)}
                    onCheckedChange={() => toggle(s.id)}
                    aria-label={`Sélectionner ${displayOrderNumber(s)}`}
                  />
                  <span className="font-medium">{displayOrderNumber(s)}</span>
                  <span className="text-muted-foreground">{s.customerName}</span>
                  {s.cityLabel && <span className="text-muted-foreground">· {s.cityLabel}</span>}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {s.trackingNumber ?? "—"}
                  </span>
                  <span className="w-24 text-right text-muted-foreground">
                    {s.cost !== null ? formatCurrency(s.cost, s.currency) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
