import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/guards";

export const metadata = {
  title: "Accès refusé — ASODITECH Gestion E-commerce",
};

export default async function AccesRefusePage() {
  await requireUser();

  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-shell bg-card p-8 text-center shadow-shell">
      <span className="flex size-14 items-center justify-center rounded-full bg-pill-red text-pill-red-fg">
        <ShieldAlert className="size-6" />
      </span>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Accès refusé</h1>
        <p className="text-sm text-ink-secondary">
          Votre rôle ne dispose pas des permissions nécessaires pour accéder à cette page.
        </p>
      </div>
      <Button className="w-full" render={<Link href="/tableau-de-bord" />}>Retour au tableau de bord</Button>
      </div>
    </div>
  );
}
