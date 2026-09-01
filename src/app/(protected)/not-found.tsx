import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Ressource introuvable — ASODITECH Gestion E-commerce",
};

/**
 * Catches `notFound()` raised inside a protected page (an id that doesn't
 * exist — client, order, product). Sits below `(protected)/layout.tsx`, so
 * the app shell stays and the user keeps their navigation.
 */
export default function ProtectedNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center">
      <FileQuestion className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Ressource introuvable</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Cet élément n&apos;existe pas ou a été supprimé.
        </p>
      </div>
      <Button variant="outline" render={<Link href="/tableau-de-bord" />}>
        Retour au tableau de bord
      </Button>
    </div>
  );
}
