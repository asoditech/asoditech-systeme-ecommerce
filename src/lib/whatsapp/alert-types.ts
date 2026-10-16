/**
 * The staff alert categories WhatsApp can deliver — docs/adr/0058 (+ the
 * 2026-10-16 addendum). Each is backed by a Meta template
 * (src/lib/whatsapp/templates.ts): the four V1 templates are approved, the
 * newer ones are only sent once the operator lists them in
 * WHATSAPP_ENABLED_TEMPLATES (`isTemplateSendable`, outbox-rules.ts).
 *
 * A category can be switched off for WhatsApp by the company
 * (`BusinessSettings.whatsappDisabledAlerts`, Intégrations → WhatsApp) or by
 * each user for themself (`User.whatsappMutedAlerts`, Paramètres →
 * Notifications). In-app and email are never affected by either.
 * Shared by the dispatcher (server) and the settings pages (client).
 *
 * Mostly NotificationType values; COMMANDE_CONFIRMEE is WhatsApp-only (there
 * is no in-app notification for a confirmation). The four V1 types come
 * first so stored lists keep their historical order.
 */
export const WHATSAPP_ALERT_TYPES = [
  "RUPTURE_STOCK",
  "ECHEC_LIVRAISON",
  "ERREUR_INTEGRATION",
  "ECHEC_SYNCHRONISATION",
  "NOUVELLE_COMMANDE",
  "COMMANDE_CONFIRMEE",
  "STOCK_FAIBLE",
  "COMMANDE_RETOURNEE",
] as const;

export type WhatsAppAlertType = (typeof WHATSAPP_ALERT_TYPES)[number];

export const WHATSAPP_ALERT_LABELS: Record<WhatsAppAlertType, string> = {
  RUPTURE_STOCK: "Rupture de stock",
  ECHEC_LIVRAISON: "Échec de livraison",
  ERREUR_INTEGRATION: "Erreur d'intégration ou de transporteur",
  ECHEC_SYNCHRONISATION: "Synchronisation des boutiques en échec",
  NOUVELLE_COMMANDE: "Nouvelle commande",
  COMMANDE_CONFIRMEE: "Commande confirmée",
  STOCK_FAIBLE: "Stock faible",
  COMMANDE_RETOURNEE: "Commande retournée",
};

export function isWhatsAppAlertType(value: unknown): value is WhatsAppAlertType {
  return typeof value === "string" && (WHATSAPP_ALERT_TYPES as readonly string[]).includes(value);
}

/** Next stored mute / company-disabled list (known types only, no duplicates, canonical order). */
export function nextMutedAlerts(current: readonly string[], type: WhatsAppAlertType, muted: boolean): WhatsAppAlertType[] {
  const kept = current.filter(isWhatsAppAlertType).filter((t) => t !== type);
  const list = muted ? [...kept, type] : kept;
  return WHATSAPP_ALERT_TYPES.filter((t) => list.includes(t));
}

/** Whether a WhatsApp alert of `type` is switched off by this mute / disabled list. */
export function isWhatsAppAlertMuted(muted: readonly string[] | null | undefined, type: string | undefined): boolean {
  return Boolean(type && muted?.includes(type));
}
