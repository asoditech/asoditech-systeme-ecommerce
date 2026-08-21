import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "@/components/auth/login-form";
import { BrandMark } from "@/components/brand-mark";

export const metadata = {
  title: "Connexion — ASODITECH Gestion E-commerce",
};

export default async function ConnexionPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/tableau-de-bord");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BrandMark variant="full" />
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">Connexion</h1>
            <p className="text-sm text-muted-foreground">Connectez-vous à votre espace ASODITECH.</p>
          </div>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
