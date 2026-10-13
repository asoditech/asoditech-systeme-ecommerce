/**
 * A quiet credibility strip kept at the bottom of the content area: the
 * ownership line only. Purely informational aside from the YounessWeb
 * credit link. Deliberately thin (h-9) with a solid background so it
 * reads as chrome, not content.
 *
 * `sticky bottom-0` as the last child of the content column (sidebar-shell),
 * not `fixed`: it takes the column's width, so it follows the sidebar's
 * collapsed / expanded width with no offset to keep in sync (a fixed
 * `md:left-64` left a gap whenever the sidebar was collapsed). The window
 * scrolls, so it stays pinned to the viewport bottom like before, and at the
 * end of a page it sits after `<main>` instead of over it.
 */
export function IntegrationsFooter() {
  return (
    <footer className="sticky bottom-0 z-30 h-9 shrink-0 bg-content text-[11px] text-ink-muted print:hidden">
      <div className="mx-auto flex h-full w-full max-w-[1600px] items-center justify-center px-4 md:px-6">
        <span className="truncate text-muted-foreground/70">
          © 2026 ASODITECH — Tous droits réservés. Système protégé et développé par{" "}
          <a
            href="https://www.younessweb.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            YounessWeb
          </a>
          .
        </span>
      </div>
    </footer>
  );
}
