import { describe, expect, it } from "vitest";
import { companyCategorySwitchState, personalOptInSwitchState } from "@/lib/whatsapp/ui-state";

/** WhatsApp switches say what the persisted values really mean (pure). */
describe("company category switch state (Intégrations → Alertes WhatsApp — suivi)", () => {
  const base = { enabledForCompany: true, senderConfigured: true, tenantEnabled: true, templateAvailable: true };

  it("« Activée » only when the alerts can really go out", () => {
    expect(companyCategorySwitchState(base)).toEqual({ label: "Activée", tone: "active", reason: null });
  });

  it("enabled but the company channel is off → « Inactive — canal WhatsApp désactivé », never « Activée »", () => {
    const s = companyCategorySwitchState({ ...base, tenantEnabled: false });
    expect(s).toEqual({ label: "Inactive — canal WhatsApp désactivé", tone: "inactive", reason: "canal WhatsApp désactivé" });
  });

  it("enabled but no central sender / template not approved → inactive with the reason (sender first)", () => {
    expect(companyCategorySwitchState({ ...base, senderConfigured: false, tenantEnabled: false }).label).toBe(
      "Inactive — numéro d'envoi non configuré"
    );
    expect(companyCategorySwitchState({ ...base, templateAvailable: false }).label).toBe("Inactive — modèle non approuvé");
  });

  it("switched off by the company → « Désactivée » whatever the channel", () => {
    for (const tenantEnabled of [true, false]) {
      expect(companyCategorySwitchState({ ...base, enabledForCompany: false, tenantEnabled })).toEqual({
        label: "Désactivée",
        tone: "off",
        reason: null,
      });
    }
  });
});

describe("personal opt-in switch state (Paramètres → Notifications)", () => {
  it("opted in + channel available → active; channel unavailable → inactive with reason; not opted in → off", () => {
    expect(personalOptInSwitchState({ optedIn: true, channelAvailable: true }).tone).toBe("active");
    expect(personalOptInSwitchState({ optedIn: true, channelAvailable: false })).toEqual({
      label: "Notifications activées — inactives",
      tone: "inactive",
      reason: "canal WhatsApp indisponible",
    });
    expect(personalOptInSwitchState({ optedIn: false, channelAvailable: false }).label).toBe("Notifications désactivées");
  });
});
