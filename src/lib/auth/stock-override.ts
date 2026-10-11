import type { UserRole } from "@prisma/client";
import { userHasPermission, type Permission } from "@/lib/auth/permissions";

/**
 * Who may confirm an Online order despite a stock shortage (P2).
 *
 * BOTH conditions, server-side:
 *  1. a hard ROLE check — OWNER, ADMIN or MANAGER only. Per-user GRANTs only
 *     change `permissions`, never `role`, so no GRANT can make another role
 *     pass this (a GRANT row forged directly in the database included);
 *  2. the effective permission `orders.confirm_out_of_stock` — OWNER/ADMIN
 *     always hold it (global roles ignore overrides), a MANAGER holds it by
 *     role baseline and loses it with a per-user DENY.
 */
export const STOCK_OVERRIDE_ROLES: readonly UserRole[] = ["OWNER", "ADMIN", "MANAGER"];
export const STOCK_OVERRIDE_PERMISSION: Permission = "orders.confirm_out_of_stock";

export function canOverrideStock(user: { role: UserRole; permissions: ReadonlySet<Permission> }): boolean {
  return STOCK_OVERRIDE_ROLES.includes(user.role) && userHasPermission(user, STOCK_OVERRIDE_PERMISSION);
}

export const STOCK_OVERRIDE_REASON_MIN = 3;
export const STOCK_OVERRIDE_REASON_MAX = 500;

/** The trimmed reason, or an error message — 3 to 500 characters after trimming. */
export function parseStockOverrideReason(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof raw === "string" ? raw.trim() : "";
  if (reason.length < STOCK_OVERRIDE_REASON_MIN) {
    return { ok: false, error: "Indiquez le motif de la confirmation malgré la rupture (3 caractères minimum)." };
  }
  if (reason.length > STOCK_OVERRIDE_REASON_MAX) {
    return { ok: false, error: `Le motif ne peut pas dépasser ${STOCK_OVERRIDE_REASON_MAX} caractères.` };
  }
  return { ok: true, reason };
}
