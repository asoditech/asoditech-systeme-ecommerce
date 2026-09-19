"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Store, Globe, MapPin } from "lucide-react";
import { createSalesChannelAction, updateSalesChannelAction, setChannelLocationsAction } from "@/actions/channels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WAREHOUSE_TYPE_LABELS } from "@/lib/status-labels";

/**
 * Business-channel administration (docs/adr/0038). A channel is a business
 * ACTIVITY — where products are sold and which transactions belong to which
 * business. It maps to the physical locations it sells from; it holds no
 * stock, and no quantity is ever stored on a channel.
 */

export interface ChannelRow {
  id: string;
  name: string;
  kind: "ONLINE" | "OFFLINE";
  isActive: boolean;
  isDefault: boolean;
  warehouseIds: string[];
  productCount: number;
  userCount: number;
}
export interface LocationOption {
  id: string;
  name: string;
  type: "ENTREPOT" | "MAGASIN";
}

const KIND_LABEL = { ONLINE: "En ligne", OFFLINE: "Magasin" } as const;

function ChannelCard({ channel, locations }: { channel: ChannelRow; locations: LocationOption[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(channel.name);
  const [selected, setSelected] = useState<Set<string>>(new Set(channel.warehouseIds));
  const Icon = channel.kind === "ONLINE" ? Globe : Store;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(success);
        router.refresh();
      } else toast.error(r.error ?? "Action impossible.");
    });
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-3 space-y-0">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </div>
        <CardTitle className="text-[15px]">{channel.name}</CardTitle>
        <Badge variant="outline">{KIND_LABEL[channel.kind]}</Badge>
        {channel.isDefault && <Badge variant="secondary">Par défaut</Badge>}
        {!channel.isActive && <Badge variant="destructive">Inactif</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">
          {channel.productCount} produit(s) · {channel.userCount} utilisateur(s)
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor={`name-${channel.id}`}>Nom</Label>
            <Input id={`name-${channel.id}`} value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={isPending || name.trim() === channel.name}
            onClick={() =>
              run(() => updateSalesChannelAction({ id: channel.id, name, isActive: channel.isActive }), "Canal renommé.")
            }
          >
            Renommer
          </Button>
          {!channel.isDefault && (
            <label className="ml-4 flex items-center gap-2 text-sm">
              <Switch
                checked={channel.isActive}
                disabled={isPending}
                onCheckedChange={(checked) =>
                  run(
                    () => updateSalesChannelAction({ id: channel.id, name: channel.name, isActive: checked }),
                    checked ? "Canal activé." : "Canal désactivé."
                  )
                }
              />
              Actif
            </label>
          )}
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-1.5">
            <MapPin className="size-3.5" /> Emplacements de vente
          </Label>
          <p className="text-xs text-muted-foreground">
            Les emplacements physiques d&apos;où ce canal vend. C&apos;est un rattachement, pas un stock : la quantité
            reste sur l&apos;emplacement et n&apos;est jamais dupliquée par canal.
            {channel.kind === "ONLINE" &&
              " La synchronisation du stock WooCommerce continue d'alimenter les entrepôts actifs, comme avant."}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <Checkbox
                  checked={selected.has(l.id)}
                  onCheckedChange={(checked) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(l.id);
                      else next.delete(l.id);
                      return next;
                    })
                  }
                />
                <span className="flex-1">{l.name}</span>
                <span className="text-xs text-muted-foreground">{WAREHOUSE_TYPE_LABELS[l.type]}</span>
              </label>
            ))}
          </div>
          <Button
            type="button"
            disabled={isPending}
            onClick={() => run(() => setChannelLocationsAction({ id: channel.id, warehouseIds: [...selected] }), "Emplacements enregistrés.")}
          >
            Enregistrer les emplacements
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ChannelsPanel({ channels, locations }: { channels: ChannelRow[]; locations: LocationOption[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"ONLINE" | "OFFLINE">("OFFLINE");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function create() {
    startTransition(async () => {
      const r = await createSalesChannelAction({ name, kind, warehouseIds: [...selected] });
      if (r.ok) {
        toast.success("Canal créé.");
        setName("");
        setSelected(new Set());
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <div className="space-y-4">
      {channels.map((c) => (
        <ChannelCard key={c.id} channel={c} locations={locations} />
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Nouveau canal de vente</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-channel-name">Nom</Label>
              <Input id="new-channel-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Magasin Casablanca" />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={kind} onValueChange={(v) => v && setKind(v as "ONLINE" | "OFFLINE")}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v: string) => KIND_LABEL[v as "ONLINE" | "OFFLINE"] ?? v}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OFFLINE">Magasin (vente en point de vente)</SelectItem>
                  <SelectItem value="ONLINE">En ligne</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Label>Emplacements de vente</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {locations.map((l) => (
              <label key={l.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                <Checkbox
                  checked={selected.has(l.id)}
                  onCheckedChange={(checked) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(l.id);
                      else next.delete(l.id);
                      return next;
                    })
                  }
                />
                <span className="flex-1">{l.name}</span>
                <span className="text-xs text-muted-foreground">{WAREHOUSE_TYPE_LABELS[l.type]}</span>
              </label>
            ))}
          </div>
          <Button type="button" disabled={isPending || name.trim().length < 2} onClick={create}>
            Créer le canal
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
