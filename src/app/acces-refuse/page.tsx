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
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <ShieldAlert className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Accès refusé</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Votre rôle ne dispose pas des permissions nécessaires pour accéder à cette page.
        </p>
      </div>
      <Button render={<Link href="/tableau-de-bord" />}>Retour au tableau de bord</Button>
    </div>
  );
}
