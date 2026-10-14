import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "@/components/auth/login-form";
import { AuthShell } from "@/components/auth/auth-shell";

export const metadata = {
  title: "Connexion — ASODITECH Gestion E-commerce",
};

export default async function ConnexionPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/tableau-de-bord");
  }

  return (
    <AuthShell title="Connexion" description="Connectez-vous à votre espace ASODITECH.">
      <LoginForm />
    </AuthShell>
  );
}
