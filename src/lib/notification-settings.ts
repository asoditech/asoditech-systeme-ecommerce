import "server-only";

import { prisma } from "@/lib/prisma";
import type { Permission } from "@/lib/auth/permissions";
import type { CurrentUser } from "@/lib/auth/session";
import { isEmailConfigured } from "@/lib/email";
import { isWhatsAppConfigured } from "@/lib/whatsapp/client";
import { maskWhatsAppPhone } from "@/lib/whatsapp/phone";
import { parsePendingVerification } from "@/lib/whatsapp/verification";

/**
 * What Paramètres → Notifications shows a user (docs/adr/0058 "Final
 * responsibility split"). READ-ONLY view of the real backend rules — it
 * decides nothing. Who is notified is decided only by `notify()` and its
 * channel layers (src/lib/notifications.ts, src/lib/email.ts,
 * src/lib/whatsapp/dispatch.ts); this mirrors them so the page never shows
 * a channel or an alert that would not actually reach the user.
 */

export type Channel = "inApp" | "email" | "whatsapp";

export interface AlertRule {
  key: string;
  label: string;
  /** Receiving it needs ANY of these effective permissions (same as notify()). */
  anyOf: Permission[];
  channels: Channel[];
  /** Restricted to the user's locations (ADR 0056). */
  locationScoped?: boolean;
  note?: string;
}

/** Mirrors the notify* helpers' recipientPermission and channel opt-ins. */
export const ALERT_RULES: readonly AlertRule[] = [
  { key: "rupture", label: "Rupture de stock", anyOf: ["inventory.view"], channels: ["inApp", "email", "whatsapp"], locationScoped: true },
  {
    key: "echec_livraison",
    label: "Échec de livraison",
    anyOf: ["delivery.view"],
    channels: ["inApp", "email", "whatsapp"],
    note: "WhatsApp : un résumé au plus par jour.",
  },
  {
    key: "erreur_integration",
    label: "Erreur d'intégration ou de transporteur",
    anyOf: ["integrations.view", "delivery.view"],
    channels: ["inApp", "email", "whatsapp"],
    note: "Boutiques et WhatsApp : droit Intégrations. Transporteurs : droit Livraison.",
  },
  { key: "limite_forfait", label: "Limite du forfait atteinte (100 %)", anyOf: ["settings.manage"], channels: ["inApp", "email"] },
  { key: "stock_faible", label: "Stock faible", anyOf: ["inventory.view"], channels: ["inApp"], locationScoped: true },
  { key: "commandes", label: "Commandes : nouvelles, paiements, retours, stock insuffisant, incohérences", anyOf: ["orders.view"], channels: ["inApp"] },
  { key: "synchronisation", label: "Synchronisation des boutiques", anyOf: ["integrations.view"], channels: ["inApp"] },
  { key: "forfait_seuils", label: "Utilisation du forfait (80 % et 90 %)", anyOf: ["settings.manage"], channels: ["inApp"] },
  { key: "support", label: "Signalements du centre d'aide", anyOf: ["settings.view"], channels: ["inApp"] },
];

export type WhatsAppStatus = "unavailable" | "no_number" | "pending" | "active" | "disabled";

/** The same conditions src/lib/whatsapp/dispatch.ts applies at send time. */
export function whatsAppStatus(s: {
  channelAvailable: boolean;
  phone: string | null;
  verified: boolean;
  optedIn: boolean;
}): WhatsAppStatus {
  if (!s.channelAvailable) return "unavailable";
  if (!s.phone) return "no_number";
  if (!s.verified) return "pending";
  return s.optedIn ? "active" : "disabled";
}

export function alertsForUser(permissions: ReadonlySet<Permission>): AlertRule[] {
  return ALERT_RULES.filter((r) => r.anyOf.some((p) => permissions.has(p)));
}

export interface MyNotificationSettings {
  email: { address: string; available: boolean };
  whatsapp: {
    status: WhatsAppStatus;
    /** Why the channel is unavailable (only set when it is). */
    unavailableReason: "tenant_disabled" | "not_configured" | null;
    maskedPhone: string | null;
    verified: boolean;
    optedIn: boolean;
    codePending: boolean;
  };
  alerts: AlertRule[];
  locationScope: { global: boolean; count: number };
}

export async function getMyNotificationSettings(user: CurrentUser): Promise<MyNotificationSettings> {
  const [own, integration] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { whatsappPhone: true, whatsappVerifiedAt: true, whatsappOptInAt: true, whatsappVerification: true },
    }),
    prisma.integration.findFirst({ where: { provider: "WHATSAPP" }, select: { status: true } }),
  ]);
  const configured = isWhatsAppConfigured();
  const tenantEnabled = integration?.status === "CONNECTE";
  const channelAvailable = configured && tenantEnabled;
  const pending = parsePendingVerification(own.whatsappVerification);
  const verified = Boolean(own.whatsappVerifiedAt);
  const optedIn = Boolean(own.whatsappOptInAt);

  return {
    email: { address: user.email, available: isEmailConfigured() },
    whatsapp: {
      status: whatsAppStatus({ channelAvailable, phone: own.whatsappPhone, verified, optedIn }),
      unavailableReason: channelAvailable ? null : !configured ? "not_configured" : "tenant_disabled",
      maskedPhone: own.whatsappPhone ? maskWhatsAppPhone(own.whatsappPhone) : null,
      verified,
      optedIn,
      codePending: Boolean(pending && pending.phone === own.whatsappPhone && new Date(pending.expiresAt) > new Date()),
    },
    alerts: alertsForUser(user.permissions),
    locationScope: { global: user.locations.global, count: user.locations.ids.length },
  };
}
