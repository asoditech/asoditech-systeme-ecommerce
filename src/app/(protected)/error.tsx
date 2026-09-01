"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * In-app error boundary. Because it sits below `(protected)/layout.tsx`,
 * an error in any protected page is caught here while the app shell
 * (sidebar, header) stays rendered — the user keeps their navigation.
 * The raw error message is never shown to the user.
 */
export default function ProtectedRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled error in a protected page:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center">
      <AlertTriangle className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Cette page n&apos;a pas pu être chargée</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Un problème inattendu est survenu. Réessayez ; si cela se reproduit, contactez
          l&apos;administrateur.
        </p>
        {error.digest && (
          <p className="pt-1 font-mono text-xs text-muted-foreground/70">Réf. : {error.digest}</p>
        )}
      </div>
      <Button onClick={reset}>Réessayer</Button>
    </div>
  );
}
