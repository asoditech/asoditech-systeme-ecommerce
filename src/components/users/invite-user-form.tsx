"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Copy } from "lucide-react";
import { inviteUserAction, listInvitationScopeOptionsAction } from "@/actions/invitations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { ActionResult, IdResult } from "@/actions/types";

const ASSIGNABLE_ROLES = Object.entries(USER_ROLE_LABELS).filter(([value]) => value !== "OWNER");
// Roles whose whole purpose is the Offline business (Phase 4B): not offered
// when the tenant has no store capability — the server refuses them too.
const STORE_ONLY_ROLES = new Set(["STORE_SELLER"]);

type InviteResult = ActionResult<IdResult & { inviteUrl: string }>;
type ScopeOptions = Awaited<ReturnType<typeof listInvitationScopeOptionsAction>>;

export function InviteUserForm({ channelsEnabled = false }: { channelsEnabled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [role, setRole] = useState("CONFIRMATION");
  const isGlobalRole = role === "OWNER" || role === "ADMIN";
  // A store seller's permissions are all in-store: their scope is always
  // « Magasin » (docs/adr/0047) — the picker is fixed for that role.
  const isStoreSeller = role === "STORE_SELLER";
  const [chosenScope, setChosenScope] = useState("ONLINE");
  const scope = isStoreSeller ? "OFFLINE" : chosenScope;
  const storeScope = channelsEnabled && (scope === "OFFLINE" || scope === "BOTH");
  // Invite-time precision (docs/adr/0047): the exact store channel(s) and
  // location(s) the account starts with. Loaded when the dialog opens.
  const [options, setOptions] = useState<ScopeOptions | null>(null);
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [warehouseIds, setWarehouseIds] = useState<string[]>([]);
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    listInvitationScopeOptionsAction()
      .then((o) => {
        if (!cancelled) setOptions(o);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, options]);
  const offlineChannels = options?.offlineChannels ?? [];
  const selectedChannelIds = storeScope ? channelIds : [];
  // A seller can only ever sell from a location mapped to one of their store
  // channels — offer exactly those; any other role may be given any location.
  const offerableWarehouses = (options?.warehouses ?? []).filter((w) => {
    if (!isStoreSeller) return true;
    const channels = selectedChannelIds.length > 0 ? offlineChannels.filter((c) => selectedChannelIds.includes(c.id)) : offlineChannels;
    return channels.some((c) => c.warehouseIds.includes(w.id));
  });
  const selectedWarehouseIds = isGlobalRole ? [] : warehouseIds.filter((id) => offerableWarehouses.some((w) => w.id === id));
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const [state, formAction, isPending] = useActionState<InviteResult | undefined, FormData>(
    async (_prevState, formData) => {
      const result = await inviteUserAction(formData);
      if (result.ok) {
        toast.success("Invitation créée.");
        setInviteLink(new URL(result.data.inviteUrl, window.location.origin).toString());
        router.refresh();
      } else {
        toast.error(result.error);
      }
      return result;
    },
    undefined
  );

  function reset() {
    setInviteLink(null);
    setChannelIds([]);
    setWarehouseIds([]);
    setOptions(null);
  }

  function close() {
    setOpen(false);
    reset();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button type="button" />}>
        <Plus className="size-4" />
        Inviter un utilisateur
      </DialogTrigger>
      <DialogContent>
        {inviteLink ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation créée</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Transmettez ce lien à la personne invitée — il n&apos;expire pas avant 7 jours et ne peut être utilisé
              qu&apos;une seule fois.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={inviteLink} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  navigator.clipboard.writeText(inviteLink);
                  toast.success("Lien copié.");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={close}>
                Fermer
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Inviter un utilisateur</DialogTitle>
            </DialogHeader>
            <form action={formAction} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Nom complet</Label>
                <Input id="name" name="name" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">E-mail</Label>
                <Input id="email" name="email" type="email" required />
                {state && !state.ok && state.fieldErrors?.email && (
                  <p className="text-xs text-destructive">{state.fieldErrors.email[0]}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">Rôle</Label>
                <Select name="role" value={role} onValueChange={(v) => v && setRole(v)}>
                  <SelectTrigger id="role" className="w-full">
                    <SelectValue>{(value: string) => USER_ROLE_LABELS[value] ?? value}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.filter(([value]) => channelsEnabled || !STORE_ONLY_ROLES.has(value)).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {channelsEnabled && !isGlobalRole && (
                <div className="space-y-1.5">
                  <Label htmlFor="channelScope">Portée métier</Label>
                  {isStoreSeller && <input type="hidden" name="channelScope" value="OFFLINE" />}
                  <Select
                    name={isStoreSeller ? undefined : "channelScope"}
                    value={scope}
                    onValueChange={(v) => v && setChosenScope(v)}
                    disabled={isStoreSeller}
                  >
                    <SelectTrigger id="channelScope" className="w-full">
                      <SelectValue>
                        {(value: string) =>
                          value === "OFFLINE" ? "Magasin" : value === "BOTH" ? "En ligne + Magasin" : "En ligne"
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ONLINE">En ligne</SelectItem>
                      <SelectItem value="OFFLINE">Magasin</SelectItem>
                      <SelectItem value="BOTH">En ligne + Magasin</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {isStoreSeller
                      ? "Un vendeur magasin travaille uniquement en magasin."
                      : "Détermine les canaux auxquels ce compte aura accès dès sa création. Ajustable ensuite depuis la liste des utilisateurs."}
                  </p>
                  {state && !state.ok && state.fieldErrors?.channelScope && (
                    <p className="text-xs text-destructive">{state.fieldErrors.channelScope[0]}</p>
                  )}
                </div>
              )}
              {storeScope && !isGlobalRole && offlineChannels.length > 0 && (
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">Canaux magasin</legend>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {offlineChannels.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                        <Checkbox
                          checked={channelIds.includes(c.id)}
                          onCheckedChange={(checked) => setChannelIds((prev) => toggle(prev, c.id, checked === true))}
                        />
                        {c.name}
                      </label>
                    ))}
                  </div>
                  {selectedChannelIds.map((id) => (
                    <input key={id} type="hidden" name="offlineChannelIds" value={id} />
                  ))}
                  <p className="text-xs text-muted-foreground">
                    {selectedChannelIds.length > 0
                      ? "Le compte n'aura accès qu'aux canaux cochés."
                      : "Aucun canal coché : le compte aura accès à tous les canaux magasin actifs."}
                  </p>
                </fieldset>
              )}
              {!isGlobalRole && offerableWarehouses.length > 0 && (
                <fieldset className="space-y-1.5">
                  <legend className="text-sm font-medium">Emplacements</legend>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {offerableWarehouses.map((w) => (
                      <label key={w.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                        <Checkbox
                          checked={selectedWarehouseIds.includes(w.id)}
                          onCheckedChange={(checked) => setWarehouseIds((prev) => toggle(prev, w.id, checked === true))}
                        />
                        {w.name}
                      </label>
                    ))}
                  </div>
                  {selectedWarehouseIds.map((id) => (
                    <input key={id} type="hidden" name="warehouseIds" value={id} />
                  ))}
                  <p className="text-xs text-muted-foreground">
                    {selectedWarehouseIds.length > 0
                      ? "Le compte pourra opérer sur ces emplacements dès l'acceptation."
                      : "Aucun emplacement coché : à attribuer ensuite depuis la liste des utilisateurs."}
                  </p>
                </fieldset>
              )}
              {channelsEnabled && isGlobalRole && (
                <p className="text-xs text-muted-foreground">
                  Ce rôle a accès à tous les canaux — aucune portée métier à choisir.
                </p>
              )}
              {state && !state.ok && <p className="text-sm text-destructive">{state.error}</p>}
              <DialogFooter>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Envoi..." : "Envoyer l'invitation"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
