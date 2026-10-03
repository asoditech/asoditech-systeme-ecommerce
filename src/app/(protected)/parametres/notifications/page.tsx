import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { AlertPreferencesCard, EmailChannelCard, InAppChannelCard } from "@/components/settings/notification-channels";
import { WhatsAppNotificationsCard } from "@/components/settings/whatsapp-notifications-card";
import { requireUser } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { getMyNotificationSettings } from "@/lib/notification-settings";

export const metadata = { title: "Notifications — Paramètres — ASODITECH Gestion E-commerce" };

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
      <PageHeader title="Paramètres" description="Informations de l'entreprise et préférences générales." />
      <div className="max-w-3xl">
        <SettingsNav
          canView={userHasPermission(user, "settings.view")}
          canManage={userHasPermission(user, "settings.manage")}
          canManageChannels={userHasPermission(user, "channels.manage")}
        />
        <div className="mb-5">
          <h2 className="text-lg font-semibold tracking-tight">Notifications</h2>
          <p className="text-sm text-muted-foreground">Choisissez comment vous souhaitez recevoir les alertes importantes.</p>
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
            locationScope={settings.locationScope}
          />
        </div>
      </div>
    </div>
  );
}
