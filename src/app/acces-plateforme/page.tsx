import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { hasPlatformUnlock, platformKeyConfigured, platformKeyRequired } from "@/lib/auth/platform-access";
import { AuthShell } from "@/components/auth/auth-shell";
import { PlatformUnlockForm } from "@/components/platform/platform-unlock-form";

export const metadata = { title: "Accès plateforme — ASODITECH Gestion E-commerce" };

/**
 * Step-up gate in front of `/platform` (docs/adr/0053). Outside `/platform`
 * on purpose: that layout itself requires the unlock. Platform admins only.
 */
export default async function AccesPlateformePage() {
  const user = await requireUser();
  if (!user.isPlatformAdmin) redirect("/acces-refuse");
  if (!platformKeyRequired() || (await hasPlatformUnlock(user.id))) redirect("/platform");

  return (
    <AuthShell title="Accès plateforme" description="Saisissez la clé d'accès plateforme pour gérer les espaces clients.">
      {platformKeyConfigured() ? (
        <PlatformUnlockForm />
      ) : (
        <p className="text-sm text-muted-foreground">
          L&apos;accès plateforme n&apos;est pas configuré sur ce déploiement : définissez PLATFORM_ACCESS_KEY_SHA256 dans
          les variables d&apos;environnement, puis redéployez.
        </p>
      )}
    </AuthShell>
  );
}
