import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { AlertPreferencesCard, EmailChannelCard, InAppChannelCard } from "@/components/settings/notification-channels";
import { WhatsAppNotificationsCard } from "@/components/settings/whatsapp-notifications-card";
import { AccountSecurityCard } from "@/components/settings/account-security-card";
import { requireUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { getMyNotificationSettings } from "@/lib/notification-settings";

export const metadata = { title: "Notifications — Paramètres — ASODITECH Gestion E-commerce" };

// What this page actually controls — only the signed-in user's own settings
// (channel/provider setup stays in Intégrations, see the doc comment below).
const NOTIFICATIONS_PAGE_DESCRIPTION = "Vos notifications personnelles et la sécurité de votre compte.";
const NOTIFICATIONS_SECTION_SUBTITLE =
  "Ces réglages ne concernent que votre compte : alertes dans l'application (avec son), par email et sur WhatsApp, alertes reçues selon votre rôle et coupure d'une alerte sur WhatsApp uniquement.";

/**
 * Paramètres → Notifications — the user's OWN communication settings
 * (docs/adr/0058 "Final responsibility split"). Every signed-in user, any
 * role: it only ever reads/changes the session user. Channel/provider
 * configuration stays in Intégrations; who gets which alert stays in the
 * notification engine.
 */
export default async function NotificationSettingsPage() {
  const user = await requireUser();
  const settings = await getMyNotificationSettings(user);

  return (
    <div>
      <PageHeader title="Paramètres" description={NOTIFICATIONS_PAGE_DESCRIPTION} />
      <div className="max-w-3xl">
        <SettingsNav
          canView={userHasPermission(user, "settings.view")}
          canManage={userHasPermission(user, "settings.manage")}
          canManageChannels={userHasPermission(user, "channels.manage")}
        />
        <div className="mb-5">
          <h2 className="text-lg font-semibold tracking-tight">Notifications</h2>
          <p className="text-sm text-muted-foreground">{NOTIFICATIONS_SECTION_SUBTITLE}</p>
        </div>
        <div className="space-y-5">
          <InAppChannelCard />
          <EmailChannelCard address={settings.email.address} available={settings.email.available} />
          <WhatsAppNotificationsCard
            status={settings.whatsapp.status}
            unavailableReason={settings.whatsapp.unavailableReason}
            maskedPhone={settings.whatsapp.maskedPhone}
            verified={settings.whatsapp.verified}
            optedIn={settings.whatsapp.optedIn}
            codePending={settings.whatsapp.codePending}
            canConfigureChannel={userHasPermission(user, "integrations.manage")}
          />
          <AlertPreferencesCard
            alerts={settings.alerts}
            emailAvailable={settings.email.available}
            whatsappStatus={settings.whatsapp.status}
            whatsappMuted={settings.whatsappMuted}
            whatsappUnavailable={settings.whatsappUnavailable}
            locationScope={settings.locationScope}
          />
          <AccountSecurityCard />
        </div>
      </div>
    </div>
  );
}
