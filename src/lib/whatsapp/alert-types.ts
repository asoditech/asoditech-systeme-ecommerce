/**
 * The staff alerts WhatsApp can actually deliver (each backed by a
 * Meta-approved template in src/lib/whatsapp/templates.ts) — and therefore
 * the only ones a user can mute individually for WhatsApp
 * (`User.whatsappMutedAlerts`). In-app and email are never affected by a
 * mute. Shared by the dispatcher (server) and the settings page (client).
 *
 * Not here on purpose (no approved template yet, in-app only):
 * COMMANDE_RETOURNEE, order status changes, « prête à expédier » — see
 * docs/CLIENT-ENVIRONMENT-VARIABLES.md (WhatsApp) for the templates needed.
 */
export const WHATSAPP_ALERT_TYPES = ["RUPTURE_STOCK", "ECHEC_LIVRAISON", "ERREUR_INTEGRATION", "ECHEC_SYNCHRONISATION"] as const;

export type WhatsAppAlertType = (typeof WHATSAPP_ALERT_TYPES)[number];

export function isWhatsAppAlertType(value: unknown): value is WhatsAppAlertType {
  return typeof value === "string" && (WHATSAPP_ALERT_TYPES as readonly string[]).includes(value);
}

/** Next stored mute list (known types only, no duplicates). */
export function nextMutedAlerts(current: readonly string[], type: WhatsAppAlertType, muted: boolean): WhatsAppAlertType[] {
  const kept = current.filter(isWhatsAppAlertType).filter((t) => t !== type);
  const list = muted ? [...kept, type] : kept;
  return WHATSAPP_ALERT_TYPES.filter((t) => list.includes(t));
}

/** Whether a WhatsApp alert of `type` goes to a user with this mute list. */
export function isWhatsAppAlertMuted(muted: readonly string[] | null | undefined, type: string | undefined): boolean {
  return Boolean(type && muted?.includes(type));
}
