"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MapPin, Trash2, RefreshCw } from "lucide-react";
import {
  getDeliveryCityMappingContextAction,
  createDeliveryCityMappingAction,
  updateDeliveryCityMappingAction,
  deleteDeliveryCityMappingAction,
  type DeliveryCityMappingContext,
} from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Operator UI for the generic provider city-mapping layer — see
 * docs/adr/0018-delivery-city-mapping.md. One dialog per API provider row
 * in Livraison → Prestataires. Provider-agnostic: it only ever shows the
 * provider's own catalogue (never a fabricated list) and, for a provider
 * that exposes none, says exactly that instead of offering a free-text id.
 *
 * The catalogue is a live provider call, so it is loaded lazily when the
 * dialog opens, not on every Livraison render.
 */
export function CityMappingDialog({ providerId, providerName }: { providerId: string; providerName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<DeliveryCityMappingContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoad] = useTransition();
  const [isMutating, startMutate] = useTransition();

  const [newLocalCity, setNewLocalCity] = useState("");
  const [newProviderCityId, setNewProviderCityId] = useState<string | undefined>(undefined);

  const load = useCallback(() => {
    startLoad(async () => {
      const fd = new FormData();
      fd.set("providerId", providerId);
      const result = await getDeliveryCityMappingContextAction(fd);
      if (result.ok) {
        setCtx(result.data);
        setLoadError(null);
      } else {
        setLoadError(result.error);
      }
    });
  }, [providerId]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setCtx(null);
      setLoadError(null);
      setNewLocalCity("");
      setNewProviderCityId(undefined);
      load();
    }
  }

  function runMutation(fn: () => Promise<{ ok: boolean; error?: string }>, successMessage: string) {
    startMutate(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(successMessage);
        setNewLocalCity("");
        setNewProviderCityId(undefined);
        load();
        router.refresh();
      } else {
        toast.error(result.error ?? "Échec de l'opération.");
      }
    });
  }

  function create() {
    if (!newLocalCity.trim() || !newProviderCityId) {
      toast.error("Renseignez la ville locale et la ville du transporteur.");
      return;
    }
    const fd = new FormData();
    fd.set("providerId", providerId);
    fd.set("localCity", newLocalCity.trim());
    fd.set("providerCityId", newProviderCityId);
    runMutation(() => createDeliveryCityMappingAction(fd), "Correspondance ajoutée.");
  }

  function update(id: string, providerCityId: string) {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("providerCityId", providerCityId);
    runMutation(() => updateDeliveryCityMappingAction(fd), "Correspondance mise à jour.");
  }

  function remove(id: string) {
    const fd = new FormData();
    fd.set("id", id);
    runMutation(() => deleteDeliveryCityMappingAction(fd), "Correspondance supprimée.");
  }

  const catalogue = ctx?.catalogue ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <MapPin className="size-4" />
        Correspondances de villes
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Correspondances de villes — {providerName}</DialogTitle>
          <DialogDescription>
            Associez une ville de vos commandes à la ville exacte du catalogue du transporteur. Utilisé en priorité
            lors de la création d&apos;une expédition, avant toute correspondance automatique.
          </DialogDescription>
        </DialogHeader>

        {isLoading && !ctx && <p className="text-sm text-muted-foreground">Chargement…</p>}

        {loadError && (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={load} disabled={isLoading}>
              <RefreshCw className="size-4" />
              Réessayer
            </Button>
          </div>
        )}

        {ctx && !ctx.catalogueSupported && (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            Ce prestataire n&apos;expose pas de catalogue de villes sélectionnable via l&apos;intégration actuelle.
            Aucune correspondance de ville ne peut être enregistrée ici.
          </p>
        )}

        {ctx && ctx.catalogueSupported && catalogue.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Le catalogue des villes du transporteur est momentanément indisponible.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={load} disabled={isLoading}>
              <RefreshCw className="size-4" />
              Réessayer
            </Button>
          </div>
        )}

        {ctx && ctx.catalogueSupported && catalogue.length > 0 && (
          <div className="space-y-4">
            <div className="space-y-2">
              {ctx.mappings.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune correspondance enregistrée pour le moment.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {ctx.mappings.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium" title={m.localCityLabel}>
                        {m.localCityLabel}
                      </span>
                      <span className="text-muted-foreground">→</span>
                      <Select
                        defaultValue={m.providerCityId}
                        onValueChange={(v: string | null) => {
                          if (v && v !== m.providerCityId) update(m.id, v);
                        }}
                      >
                        <SelectTrigger className="h-8 w-44" disabled={isMutating}>
                          <SelectValue>
                            {(value: string) => catalogue.find((c) => c.id === value)?.name ?? m.providerCityName}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {catalogue.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Supprimer la correspondance pour ${m.localCityLabel}`}
                        disabled={isMutating}
                        onClick={() => remove(m.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">Ajouter une correspondance</p>
              <div className="space-y-1.5">
                <Label htmlFor="mapping-local-city">Ville locale (telle qu&apos;elle apparaît sur la commande)</Label>
                <Input
                  id="mapping-local-city"
                  value={newLocalCity}
                  onChange={(e) => setNewLocalCity(e.target.value)}
                  placeholder="Casablanca"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mapping-provider-city">Ville du transporteur</Label>
                <Select value={newProviderCityId} onValueChange={(v: string | null) => setNewProviderCityId(v ?? undefined)}>
                  <SelectTrigger id="mapping-provider-city" className="w-full">
                    <SelectValue placeholder="Choisir dans le catalogue">
                      {(value: string) => catalogue.find((c) => c.id === value)?.name ?? "Choisir dans le catalogue"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {catalogue.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" size="sm" onClick={create} disabled={isMutating}>
                Ajouter
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
