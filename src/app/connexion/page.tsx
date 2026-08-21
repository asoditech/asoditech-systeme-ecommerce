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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-white p-4">
      {/* soft color blobs the glass card refracts */}
      <div
        aria-hidden
        className="animate-blob-breathe-a pointer-events-none absolute left-[28%] top-[22%] h-[420px] w-[420px] rounded-full opacity-60 blur-[90px]"
        style={{ backgroundImage: "radial-gradient(circle, #2563eb 0%, transparent 70%)" }}
      />
      <div
        aria-hidden
        className="animate-blob-breathe-b pointer-events-none absolute left-[74%] top-[28%] h-[360px] w-[360px] rounded-full opacity-50 blur-[90px]"
        style={{
          backgroundImage:
            "radial-gradient(ellipse at top, #ffd93d 0%, #ff8a3d 40%, #ff3d3d 70%, transparent 80%)",
        }}
      />
      <div
        aria-hidden
        className="animate-blob-breathe-c pointer-events-none absolute left-[50%] top-[80%] h-[380px] w-[460px] rounded-full opacity-40 blur-[100px]"
        style={{ backgroundImage: "radial-gradient(circle, #7c3aed 0%, transparent 70%)" }}
      />

      {/* frosted glass card */}
      <div className="relative w-full max-w-sm rounded-3xl border border-white/60 bg-white/55 p-8 shadow-[0_20px_60px_-15px_rgba(30,41,59,0.25)] backdrop-blur-2xl">
        <div className="mb-8 flex flex-col items-center gap-6">
          <BrandMark variant="wordmark" />
          <div className="space-y-1 text-center">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Connexion</h1>
            <p className="text-sm text-muted-foreground">
              Connectez-vous à votre espace ASODITECH.
            </p>
          </div>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
