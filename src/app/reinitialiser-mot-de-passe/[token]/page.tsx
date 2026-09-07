import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { findUsablePasswordResetToken } from "@/lib/auth/token-lookup";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata = { title: "Réinitialiser le mot de passe — ASODITECH Gestion E-commerce" };

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/tableau-de-bord");
  }

  const { token } = await params;
  const found = await findUsablePasswordResetToken(token);

  if (!found || !found.usable) {
    return (
      <AuthShell title="Lien invalide" description="Ce lien de réinitialisation n'est plus valide.">
        <p className="text-sm text-muted-foreground">
          Il a peut-être expiré ou déjà été utilisé. Demandez un nouveau lien depuis la page de connexion.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Nouveau mot de passe" description="Choisissez un nouveau mot de passe pour votre compte.">
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
