"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import type { UserRole } from "@prisma/client";
import { setUserPermissionOverridesAction, setUserChannelsAction } from "@/actions/users";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PERMISSION_CHANNEL_DOMAIN, type Permission } from "@/lib/auth/permissions";
// PURE, no Prisma/server-only (see its own doc comment) — the exact same
// function the server uses to compute the real effective-access set, so
// this dialog's "Accès effectif" summary is never a second, drifting
// reimplementation of the RBAC formula (Phase 2 requirement).
import { computeEffectiveAccess } from "@/lib/auth/effective-access";
import type { BusinessMode } from "@/lib/tenant/business-mode";
import { presetsForRole, responsibilityGrants, responsibilityRevocations, responsibilityStatus } from "@/lib/auth/responsibilities";

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
  role,
  businessMode,
  sellerPriceOverride = false,
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
  /** The target user's role — needed (only) to feed the SAME `computeEffectiveAccess` the server uses, for the "Accès effectif" summary. */
  role: UserRole;
  /** The tenant's business mode (docs/adr/0041) — same reason. */
  businessMode: BusinessMode;
  /** BusinessSettings.allowSellerPriceOverride — same reason (company-wide `sales.override_price` for store sellers). */
  sellerPriceOverride?: boolean;
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
  const base = useMemo(() => new Set<string>(baseline), [baseline]);

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

  // Only what DIFFERS from the role baseline is a REAL override: "allow"
  // something the role already has, or "deny" something it lacks, is a
  // no-op — never stored, and never counted as "custom" in the summary.
  // One shared computation so `save()` and the live "Accès effectif"
  // summary can never drift from each other.
  const newGrants = useMemo(() => permissions.filter((p) => states[p] === "grant" && !base.has(p)), [permissions, states, base]);
  const newDenies = useMemo(() => permissions.filter((p) => states[p] === "deny" && base.has(p)), [permissions, states, base]);

  // "Accès effectif" (Phase 2): computed live, from the SAME
  // `computeEffectiveAccess` the server calls on every request — never a
  // client reimplementation of the formula. Reflects the in-progress draft
  // (unsaved toggle/channel changes), which is the whole point: the admin
  // sees the consequence of a choice before clicking "Enregistrer".
  const effectiveAccess = useMemo(
    () =>
      computeEffectiveAccess({
        role,
        overrides: [
          ...newGrants.map((permission) => ({ permission, effect: "GRANT" as const })),
          ...newDenies.map((permission) => ({ permission, effect: "DENY" as const })),
        ],
        assignedChannels: channels
          .filter((c) => selectedChannels.has(c.id))
          .map((c) => ({ id: c.id, kind: c.kind, isActive: true })),
        businessMode,
        sellerPriceOverride,
      }),
    [role, newGrants, newDenies, channels, selectedChannels, businessMode, sellerPriceOverride]
  );
  const activeCount = permissions.filter((p) => effectiveAccess.permissions.has(p)).length;
  const scopeLabel = !channelsEnabled
    ? "En ligne"
    : effectiveAccess.channels.online && effectiveAccess.channels.offline
      ? "En ligne + Magasin"
      : effectiveAccess.channels.online
        ? "En ligne uniquement"
        : effectiveAccess.channels.offline
          ? "Magasin uniquement"
          : "Aucun canal attribué";

  function save() {
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

          {/* Phase 2 — "Accès effectif": one authoritative summary, computed
              via computeEffectiveAccess (never a second RBAC formula),
              reflecting the draft toggles/channels below in real time. */}
          <div className="space-y-2 rounded-md border bg-muted/30 p-3">
            <p className="text-sm font-medium">Accès effectif</p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant="secondary">{scopeLabel}</Badge>
              <span className="text-muted-foreground">
                {activeCount} permission{activeCount > 1 ? "s" : ""} sur {permissions.length} active
                {activeCount > 1 ? "s" : ""}
              </span>
            </div>
            {(newGrants.length > 0 || newDenies.length > 0) && (
              <div className="space-y-1 text-xs text-muted-foreground">
                {newGrants.length > 0 && (
                  <p>
                    <span className="font-medium text-foreground">Accordé en plus du rôle :</span>{" "}
                    {newGrants.join(", ")}
                  </p>
                )}
                {newDenies.length > 0 && (
                  <p>
                    <span className="font-medium text-foreground">Refusé malgré le rôle :</span>{" "}
                    {newDenies.join(", ")}
                  </p>
                )}
              </div>
            )}
          </div>

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

          {/* Additional responsibilities (docs/adr/0039): add or remove a named bundle of
              existing permissions, independently, in this draft — the detailed list below
              stays the source of truth and nothing is saved before « Enregistrer ». */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Responsabilités supplémentaires</p>
            <p className="text-xs text-muted-foreground">
              Un même compte peut cumuler plusieurs responsabilités et en perdre une à tout moment (par ex. un agent de
              confirmation qui gère aussi la livraison, puis consulte les analyses). « Ajouter » / « Retirer » modifient
              les permissions ci-dessous ; rien n&apos;est appliqué avant « Enregistrer ». Le rôle ne change pas.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {presetsForRole(role).map((r) => {
                const toGrant = responsibilityGrants(r.id, base, permissions);
                const status = responsibilityStatus(r.id, base, permissions, states);
                const toRevoke = responsibilityRevocations(r.id, base, permissions, states);
                return (
                  <div key={r.id} className="flex flex-col gap-1.5 rounded-md border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{r.label}</p>
                      {status === "granted" && <Badge variant="default" className="text-[10px]">Attribuée</Badge>}
                      {status === "partial" && <Badge variant="outline" className="text-[10px]">Partielle</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">{r.description}</p>
                    {status === "covered-by-role" ? (
                      <p className="text-xs text-muted-foreground">Déjà couverte par le rôle actuel.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {status !== "granted" && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setStates((prev) => {
                                const next = { ...prev };
                                for (const p of toGrant) next[p] = "grant";
                                return next;
                              })
                            }
                          >
                            Ajouter ({toGrant.length} permission{toGrant.length > 1 ? "s" : ""})
                          </Button>
                        )}
                        {toRevoke.length > 0 && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setStates((prev) => {
                                const next = { ...prev };
                                for (const p of toRevoke) delete next[p];
                                return next;
                              })
                            }
                          >
                            Retirer
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {channelsEnabled && (
              <p className="text-xs text-muted-foreground">
                La confirmation et la livraison concernent les commandes en ligne : elles restent sans effet tant que le
                canal « En ligne » n&apos;est pas coché ci-dessus.
              </p>
            )}
          </div>

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
                        // Batch 16 — the resulting access this row's choice actually
                        // produces, spelled out next to it: (role ∪ grant) − deny,
                        // the SAME formula this dialog's own doc comment already
                        // states — applied here only to already-known local UI
                        // state, never a second read of the real authorization data.
                        const effective = state === "deny" ? false : state === "grant" ? true : base.has(p);
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
                            <Badge
                              variant={effective ? "default" : "outline"}
                              className={"text-[10px] " + (effective ? "" : "text-muted-foreground")}
                              title="Accès effectif résultant de ce choix"
                            >
                              {effective ? "effectif : oui" : "effectif : non"}
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
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
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
