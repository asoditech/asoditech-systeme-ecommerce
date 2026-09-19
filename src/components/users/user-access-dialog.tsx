"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { setUserPermissionOverridesAction, setUserChannelsAction } from "@/actions/users";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PERMISSION_CHANNEL_DOMAIN, type Permission } from "@/lib/auth/permissions";

/**
 * Individual access (docs/adr/0039): the role gives a BASELINE; this dialog
 * records how ONE user differs from it — extra permissions (GRANT), removed
 * ones (DENY), and which business channels they may act on and read. Nobody
 * needs a new role for one extra capability.
 *
 *   effective = (role ∪ grants) − denies, then filtered by channel scope
 *
 * A permission belonging to an activity the user has no channel for stays
 * inert until that channel is assigned (a GRANT never bypasses scope).
 */

const MODULE_LABELS: Record<string, string> = {
  dashboard: "Tableau de bord",
  orders: "Commandes (en ligne)",
  customers: "Clients",
  products: "Produits",
  inventory: "Stock",
  warehouses: "Emplacements",
  delivery: "Livraison",
  finance: "Finance",
  commissions: "Commissions",
  marketing: "Marketing",
  analytics: "Analyses & rapports",
  users: "Utilisateurs",
  settings: "Paramètres",
  audit: "Journal d'audit",
  integrations: "Intégrations",
  ai: "Assistant IA",
  suppliers: "Fournisseurs",
  purchases: "Achats & réceptions",
  sales: "Ventes en magasin",
  channels: "Canaux de vente",
};

type State = "inherit" | "grant" | "deny";

export function UserAccessDialog({
  userId,
  name,
  permissions,
  baseline,
  grants,
  denies,
  channels,
  assignedChannelIds,
  channelsEnabled,
}: {
  userId: string;
  name: string;
  /** Every permission a per-user override may target (users.manage excluded server-side too). */
  permissions: Permission[];
  /** What the user's ROLE already grants. */
  baseline: Permission[];
  grants: string[];
  denies: string[];
  channels: { id: string; name: string; kind: "ONLINE" | "OFFLINE" }[];
  assignedChannelIds: string[];
  /** False in an ONLINE_ONLY tenant: no channel scope exists there (docs/adr/0041). */
  channelsEnabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const base = new Set<string>(baseline);

  const initialStates = (): Record<string, State> => {
    const s: Record<string, State> = {};
    for (const g of grants) s[g] = "grant";
    for (const d of denies) s[d] = "deny";
    return s;
  };
  const [states, setStates] = useState<Record<string, State>>(initialStates);
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set(assignedChannelIds));

  function reset() {
    setStates(initialStates());
    setSelectedChannels(new Set(assignedChannelIds));
  }

  function save() {
    // Only store what DIFFERS from the role: an "allow" of something the role
    // already has, or a "deny" of something it lacks, is a no-op — not stored.
    const newGrants = permissions.filter((p) => states[p] === "grant" && !base.has(p));
    const newDenies = permissions.filter((p) => states[p] === "deny" && base.has(p));
    startTransition(async () => {
      const [a, b] = await Promise.all([
        setUserPermissionOverridesAction({ userId, grants: newGrants, denies: newDenies }),
        channelsEnabled
          ? setUserChannelsAction({ userId, salesChannelIds: [...selectedChannels] })
          : Promise.resolve({ ok: true as const, data: { id: userId } }),
      ]);
      if (a.ok && b.ok) {
        toast.success("Accès mis à jour.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(!a.ok ? a.error : !b.ok ? b.error : "Erreur.");
      }
    });
  }

  const byModule = new Map<string, Permission[]>();
  for (const p of permissions) {
    const group = p.split(".")[0];
    byModule.set(group, [...(byModule.get(group) ?? []), p]);
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="Accès individuels (permissions et canaux)"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <ShieldCheck className="size-4" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Accès individuels — {name}</DialogTitle>
          </DialogHeader>

          {channelsEnabled && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Canaux</p>
            <p className="text-xs text-muted-foreground">
              L&apos;utilisateur ne voit et n&apos;agit que sur les canaux cochés. Aucun canal = aucun accès aux données
              de vente.
            </p>
            <div className="flex flex-wrap gap-2">
              {channels.map((c) => (
                <label key={c.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <Checkbox
                    checked={selectedChannels.has(c.id)}
                    onCheckedChange={(checked) =>
                      setSelectedChannels((prev) => {
                        const next = new Set(prev);
                        if (checked) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                  />
                  {c.name}
                  <Badge variant="outline">{c.kind === "ONLINE" ? "En ligne" : "Magasin"}</Badge>
                </label>
              ))}
            </div>
          </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium">Permissions</p>
            <p className="text-xs text-muted-foreground">
              « Hérité » suit le rôle. « Autoriser » ajoute une permission que le rôle n&apos;a pas ; « Refuser » en
              retire une que le rôle accorde. Un refus l&apos;emporte toujours.
            </p>
            <ScrollArea className="h-72 rounded-md border">
              <div className="space-y-4 p-3">
                {[...byModule].map(([group, perms]) => (
                  <div key={group}>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {MODULE_LABELS[group] ?? group}
                    </p>
                    <div className="space-y-1">
                      {perms.map((p) => {
                        const state = states[p] ?? "inherit";
                        const domain = PERMISSION_CHANNEL_DOMAIN[p];
                        return (
                          <div key={p} className="flex items-center gap-2 text-sm">
                            <span className="flex-1 font-mono text-xs">{p}</span>
                            {domain && (
                              <span className="text-[10px] text-muted-foreground">
                                {domain === "ONLINE" ? "canal en ligne" : "canal magasin"}
                              </span>
                            )}
                            <Badge variant={base.has(p) ? "secondary" : "outline"} className="text-[10px]">
                              {base.has(p) ? "rôle : oui" : "rôle : non"}
                            </Badge>
                            <div className="flex overflow-hidden rounded-md border text-xs">
                              {(["inherit", "grant", "deny"] as const).map((opt) => (
                                <button
                                  key={opt}
                                  type="button"
                                  aria-pressed={state === opt}
                                  onClick={() => setStates((prev) => ({ ...prev, [p]: opt }))}
                                  className={
                                    "px-2 py-1 " +
                                    (state === opt
                                      ? opt === "deny"
                                        ? "bg-destructive text-destructive-foreground"
                                        : opt === "grant"
                                          ? "bg-primary text-primary-foreground"
                                          : "bg-muted"
                                      : "hover:bg-muted/60")
                                  }
                                >
                                  {opt === "inherit" ? "Hérité" : opt === "grant" ? "Autoriser" : "Refuser"}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Annuler
            </Button>
            <Button type="button" onClick={save} disabled={isPending}>
              {isPending ? "Enregistrement..." : "Enregistrer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
