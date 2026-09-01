import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Page introuvable — ASODITECH Gestion E-commerce",
};

/**
 * Shown for any unmatched route and for every explicit `notFound()` call
 * (a customer/order/product id that doesn't exist). Replaces Next.js's
 * unstyled English default with the app's own French message.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <FileQuestion className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Page introuvable</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          La page ou la ressource que vous cherchez n&apos;existe pas ou a été déplacée.
        </p>
      </div>
      <Button render={<Link href="/tableau-de-bord" />}>Retour au tableau de bord</Button>
    </div>
  );
}
