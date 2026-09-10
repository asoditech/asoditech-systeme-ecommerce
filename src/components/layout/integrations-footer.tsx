/**
 * A quiet credibility strip fixed to the bottom of the content area: the
 * ownership line only. Purely informational aside from the YounessWeb
 * credit link. Deliberately thin (h-9) with a solid background so it
 * reads as chrome, not content; `<main>` carries matching bottom padding
 * so nothing hides behind it.
 */
export function IntegrationsFooter() {
  return (
    <footer className="fixed inset-x-0 bottom-0 z-30 h-9 border-t bg-background text-[11px] text-muted-foreground/80 md:left-64 print:hidden">
      <div className="mx-auto flex h-full w-full max-w-[1600px] items-center justify-center px-4 md:px-6">
        <span className="truncate text-muted-foreground/70">
          © 2026 ASODITECH — Tous droits réservés. Système protégé et développé par{" "}
          <a
            href="https://www.younessweb.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 hover:text-foreground hover:underline"
          >
            YounessWeb
          </a>
          .
        </span>
      </div>
    </footer>
  );
}
