import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The card calls useRouter(); the shared setup only mocks redirect/notFound.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { WhatsAppNotificationsCard } from "@/components/settings/whatsapp-notifications-card";

/**
 * « Alertes WhatsApp » card UX — render only (no database). Verification is
 * never offered as a dead-end when the channel is unavailable, and when it is
 * available the card says where the code arrives and where to type it.
 * The verification backend itself is untouched (src/actions/whatsapp.ts).
 */
type Props = Parameters<typeof WhatsAppNotificationsCard>[0];
const render = (props: Partial<Props>) =>
  renderToStaticMarkup(
    createElement(WhatsAppNotificationsCard, {
      status: "pending",
      unavailableReason: null,
      maskedPhone: "+212 6•• ••• •78",
      verified: false,
      optedIn: false,
      codePending: false,
      canConfigureChannel: false,
      ...props,
    })
  );

describe("WhatsApp verification card", () => {
  it.each(["not_configured", "tenant_disabled"] as const)(
    "channel unavailable (%s): no « Vérifier le numéro » button, a clear explanation instead",
    (reason) => {
      const html = render({ status: "unavailable", unavailableReason: reason });
      expect(html).not.toContain("Vérifier le numéro");
      expect(html).not.toContain("Renvoyer le code");
      expect(html).toContain("La vérification ne peut pas être lancée pour le moment");
      expect(html).toContain("Vous pouvez déjà enregistrer votre numéro.");
    }
  );

  it("channel available: says the code arrives IN WhatsApp, from ASODITECH, on the user's own (masked) number, to be typed in « Code reçu »", () => {
    const html = render({});
    expect(html).toContain("Vérifier le numéro");
    expect(html).toContain("dans WhatsApp");
    expect(html).toContain("ASODITECH");
    expect(html).toContain("+212 6•• ••• •78");
    expect(html).toContain("« Code reçu »");
  });

  it("code pending: the « Code reçu » field and its help are shown, with resend", () => {
    const html = render({ codePending: true });
    expect(html).toContain('id="whatsapp-code"');
    expect(html).toContain("Code reçu");
    expect(html).toContain("Renvoyer le code");
    expect(html).toContain("Rien reçu ?");
  });

  it("a code already pending can still be confirmed if the channel became unavailable (confirmation sends nothing)", () => {
    const html = render({ status: "unavailable", unavailableReason: "tenant_disabled", codePending: true });
    expect(html).toContain('id="whatsapp-code"');
    expect(html).not.toContain("Renvoyer le code");
  });

  it("verified number: no verification block", () => {
    const html = render({ status: "active", verified: true, optedIn: true });
    expect(html).not.toContain("Vérifier le numéro");
    expect(html).not.toContain('id="whatsapp-code"');
  });
});
