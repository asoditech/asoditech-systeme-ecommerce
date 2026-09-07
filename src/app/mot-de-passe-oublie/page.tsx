import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { AuthShell } from "@/components/auth/auth-shell";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata = { title: "Mot de passe oublié — ASODITECH Gestion E-commerce" };

export default async function MotDePasseOubliePage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/tableau-de-bord");
  }

  return (
    <AuthShell title="Mot de passe oublié" description="Entrez votre e-mail pour recevoir un lien de réinitialisation.">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
