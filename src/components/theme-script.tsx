/**
 * Applies the persisted `.dark` class to <html> synchronously while the
 * browser parses the HTML — before the first paint — so a dark-mode user
 * never sees a light-mode flash on a full load / refresh.
 *
 * Follows Next.js's "Preventing Flash Before Hydration" guide
 * (node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md,
 * "Extracting a reusable component"): a plain inline <script> whose `type`
 * is `text/javascript` on the server — so the browser runs it during parse
 * — and `text/plain` on the client — so React's renderer treats it as an
 * inert node and does NOT emit its "Encountered a script tag while
 * rendering React component" dev warning. `suppressHydrationWarning`
 * absorbs the server/client `type` difference.
 *
 * This deliberately does NOT use `next/script`: its `beforeInteractive`
 * strategy renders a live <script> into the React tree, which is exactly
 * what trips that warning under Next 16 (Turbopack) + React 19. See
 * ThemeProvider / useTheme in theme-provider.tsx for the toggle half.
 */
const THEME_INIT_SCRIPT =
  "(function(){try{var t=localStorage.getItem('theme');" +
  "var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);" +
  "if(d)document.documentElement.classList.add('dark');" +
  "}catch(e){}})();";

export function ThemeScript() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
    />
  );
}
