import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmActionButton } from "@/components/confirm-action-button";
import { logoutAllSessionsAction } from "@/actions/auth";
import { SettingInfo } from "@/components/settings/setting-info";

/**
 * « Sécurité du compte » — the signed-in user's OWN sessions only
 * (logoutAllSessionsAction). Never tenant-wide: suspending a whole tenant
 * stays the platform's action.
 */
export function AccountSecurityCard() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-pill-peach text-pill-peach-fg">
          <ShieldCheck className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <CardTitle accent="purple">Sécurité du compte</CardTitle>
            <SettingInfo setting="accountSecurity" />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Un appareil perdu ou un accès partagé ? Fermez toutes vos sessions ouvertes, y compris celle-ci.
          </p>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-end gap-3">
        <ConfirmActionButton
          label="Se déconnecter de toutes les sessions"
          title="Se déconnecter de toutes les sessions ?"
          description="Toutes vos sessions ouvertes, sur tous vos appareils (y compris celui-ci), seront fermées immédiatement. Vous devrez vous reconnecter."
          hiddenFields={{}}
          action={logoutAllSessionsAction}
          successMessage="Toutes vos sessions ont été fermées."
          destructive
        />
      </CardContent>
    </Card>
  );
}
