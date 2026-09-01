"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Root error boundary — catches an unexpected throw in any route segment
 * that doesn't have its own closer `error.tsx` (including the protected
 * layout itself). Server Actions return typed error results instead of
 * throwing, so this is for genuine bugs, not normal validation failures.
 * The raw error message is never rendered — it can carry internal detail.
 */
export default function GlobalRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled route error:", error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <AlertTriangle className="size-10 text-muted-foreground" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Une erreur est survenue</h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Un problème inattendu a interrompu cette page. Vous pouvez réessayer ; si le problème
          persiste, contactez l&apos;administrateur.
        </p>
        {error.digest && (
          <p className="pt-1 font-mono text-xs text-muted-foreground/70">Réf. : {error.digest}</p>
        )}
      </div>
      <Button onClick={reset}>Réessayer</Button>
    </div>
  );
}
