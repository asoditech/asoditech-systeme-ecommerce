"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for an error thrown by the root layout itself
 * (before the app shell, fonts, or theme are available). It must render
 * its own <html>/<body>, so it is deliberately self-contained with inline
 * styles rather than depending on the design system. Normal page errors
 * are handled by the closer `error.tsx` boundaries.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Root layout error:", error);
  }, [error]);

  return (
    <html lang="fr">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          padding: "1rem",
          textAlign: "center",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          color: "#1f2430",
          background: "#f7f7f5",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
          Une erreur est survenue
        </h1>
        <p style={{ maxWidth: "24rem", fontSize: "0.875rem", color: "#5b616e", margin: 0 }}>
          L&apos;application n&apos;a pas pu démarrer correctement. Rechargez la page ; si le
          problème persiste, contactez l&apos;administrateur.
        </p>
        <button
          onClick={reset}
          style={{
            border: "none",
            borderRadius: "0.5rem",
            padding: "0.5rem 0.875rem",
            fontSize: "0.875rem",
            fontWeight: 500,
            color: "#fff",
            background: "#f9812f",
            cursor: "pointer",
          }}
        >
          Réessayer
        </button>
      </body>
    </html>
  );
}
