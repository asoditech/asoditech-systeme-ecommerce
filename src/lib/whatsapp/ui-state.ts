/**
 * What a WhatsApp switch must SAY, from the persisted values only (pure — no
 * database, no env). A switch shows the stored preference; the label tells
 * whether that preference currently has any effect. « Activée » is only
 * shown when alerts of that kind can really go out: the central sender is
 * configured, the company's WhatsApp channel is on and the template is
 * available. Otherwise the preference is kept but displayed as inactive,
 * with the reason.
 */

export type WhatsAppSwitchTone = "active" | "inactive" | "off";

export interface WhatsAppSwitchState {
  label: string;
  tone: WhatsAppSwitchTone;
  /** Why an enabled preference has no effect right now (null when it does / when it is off). */
  reason: string | null;
}

export const WHATSAPP_INACTIVE_REASONS = {
  notConfigured: "numéro d'envoi non configuré",
  channelDisabled: "canal WhatsApp désactivé",
  templateUnavailable: "modèle non approuvé",
} as const;

function inactiveReason(f: { senderConfigured: boolean; tenantEnabled: boolean; templateAvailable?: boolean }): string | null {
  if (!f.senderConfigured) return WHATSAPP_INACTIVE_REASONS.notConfigured;
  if (!f.tenantEnabled) return WHATSAPP_INACTIVE_REASONS.channelDisabled;
  if (f.templateAvailable === false) return WHATSAPP_INACTIVE_REASONS.templateUnavailable;
  return null;
}

/** Intégrations → « Alertes WhatsApp — suivi »: one company-level category row. */
export function companyCategorySwitchState(f: {
  enabledForCompany: boolean;
  senderConfigured: boolean;
  tenantEnabled: boolean;
  templateAvailable: boolean;
}): WhatsAppSwitchState {
  if (!f.enabledForCompany) return { label: "Désactivée", tone: "off", reason: null };
  const reason = inactiveReason(f);
  return reason ? { label: `Inactive — ${reason}`, tone: "inactive", reason } : { label: "Activée", tone: "active", reason: null };
}

/** Paramètres → Notifications: the user's own WhatsApp opt-in row. */
export function personalOptInSwitchState(f: { optedIn: boolean; channelAvailable: boolean }): WhatsAppSwitchState {
  if (!f.optedIn) return { label: "Notifications désactivées", tone: "off", reason: null };
  if (!f.channelAvailable) {
    return { label: "Notifications activées — inactives", tone: "inactive", reason: "canal WhatsApp indisponible" };
  }
  return { label: "Notifications activées", tone: "active", reason: null };
}
