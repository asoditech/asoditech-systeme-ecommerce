import type { UserRole } from "@prisma/client";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/auth/permissions";

/**
 * Additional responsibilities for ONE account (docs/adr/0039), combinable and
 * reversible over time — e.g. an order-confirmation agent who later also
 * handles delivery, then also reads analytics. No new role per combination
 * and no duplicate account: a responsibility is a named bundle of EXISTING
 * permissions, applied as per-user GRANT overrides on top of the user's own
 * (unchanged) role.
 *
 * Pure and client-safe. It only PRE-SELECTS overrides in the user-access
 * dialog's draft; saving still goes through setUserPermissionOverridesAction
 * (users.manage-gated; users.manage itself never grantable; refused for
 * permissions the tenant's mode doesn't enable; audited). Enforcement stays
 * where it always was — every page/action/query checks its own permission
 * server-side, and channel/location scope still applies on top (a delivery
 * grant is inert without the Online channel; analytics only shows the
 * channels/locations the user may read and never implies finance.view).
 * Only operational bundles are offered: never MANAGER/ADMIN/OWNER.
 */

export type ResponsibilityId = "CONFIRMATION" | "DELIVERY" | "WAREHOUSE" | "ANALYTICS";

export interface ResponsibilityPreset {
  id: ResponsibilityId;
  label: string;
  description: string;
  /** The user role this bundle mirrors, when it is exactly a role's permission set. */
  role: Extract<UserRole, "CONFIRMATION" | "DELIVERY" | "WAREHOUSE"> | null;
  permissions: readonly Permission[];
}

export const RESPONSIBILITY_PRESETS: readonly ResponsibilityPreset[] = [
  {
    id: "CONFIRMATION",
    label: "Confirmation des commandes",
    description: "File de confirmation, création et modification des commandes, fiches clients.",
    role: "CONFIRMATION",
    permissions: ROLE_PERMISSIONS.CONFIRMATION,
  },
  {
    id: "DELIVERY",
    label: "Livraison",
    description: "Expéditions, transporteurs, suivi et bons de livraison.",
    role: "DELIVERY",
    permissions: ROLE_PERMISSIONS.DELIVERY,
  },
  {
    id: "WAREHOUSE",
    label: "Entrepôt et stock",
    description: "Stock, ajustements, transferts, inventaires et réceptions.",
    role: "WAREHOUSE",
    permissions: ROLE_PERMISSIONS.WAREHOUSE,
  },
  {
    id: "ANALYTICS",
    label: "Analyses et rapports",
    description: "Analyses et rapports des canaux et emplacements de l'utilisateur — sans finance ni marges.",
    role: null,
    // Deliberately NOT finance.view: costs, margins and profit stay hidden.
    permissions: ["analytics.view"],
  },
];

export function getResponsibility(id: ResponsibilityId): ResponsibilityPreset {
  return RESPONSIBILITY_PRESETS.find((p) => p.id === id)!;
}

/** Presets worth offering to a user of `role` (a role's own bundle is already the role). */
export function presetsForRole(role: UserRole): ResponsibilityPreset[] {
  return RESPONSIBILITY_PRESETS.filter((p) => p.role !== role);
}

/**
 * The GRANTs that would add `id` to a user whose role already gives
 * `baseline`: the bundle's permissions, minus what the role already has,
 * limited to `overridable` (what an override may target in this tenant — the
 * dialog's own list, which already excludes users.manage and mode-disabled
 * permissions).
 */
export function responsibilityGrants(id: ResponsibilityId, baseline: Iterable<string>, overridable: readonly string[]): Permission[] {
  const has = new Set(baseline);
  const allowed = new Set(overridable);
  return getResponsibility(id).permissions.filter((p) => allowed.has(p) && !has.has(p));
}

export type DraftState = "inherit" | "grant" | "deny";
export type ResponsibilityStatus = "covered-by-role" | "granted" | "partial" | "none";

/** Where the draft stands for `id`: entirely from the role, fully granted, partly, or not at all. */
export function responsibilityStatus(
  id: ResponsibilityId,
  baseline: Iterable<string>,
  overridable: readonly string[],
  states: Readonly<Record<string, DraftState | undefined>>
): ResponsibilityStatus {
  const grants = responsibilityGrants(id, baseline, overridable);
  if (grants.length === 0) return "covered-by-role";
  const granted = grants.filter((p) => states[p] === "grant").length;
  if (granted === grants.length) return "granted";
  return granted > 0 ? "partial" : "none";
}

/**
 * The GRANTs to reset to « Hérité » to REMOVE `id`, independently of the
 * others: its granted permissions, except any that another responsibility
 * still fully granted in the draft also needs (e.g. orders.view, shared by
 * Livraison and Entrepôt). Never touches a DENY or a role permission.
 */
export function responsibilityRevocations(
  id: ResponsibilityId,
  baseline: Iterable<string>,
  overridable: readonly string[],
  states: Readonly<Record<string, DraftState | undefined>>
): Permission[] {
  const base = [...baseline];
  const keep = new Set<string>();
  for (const other of RESPONSIBILITY_PRESETS) {
    if (other.id === id) continue;
    if (responsibilityStatus(other.id, base, overridable, states) === "granted") {
      for (const p of responsibilityGrants(other.id, base, overridable)) keep.add(p);
    }
  }
  return responsibilityGrants(id, base, overridable).filter((p) => states[p] === "grant" && !keep.has(p));
}
