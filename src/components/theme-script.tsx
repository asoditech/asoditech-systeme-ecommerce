import Script from "next/script";

/**
 * Applies the persisted theme class to <html> before first paint, avoiding
 * a light-mode flash on load. Uses next/script's `beforeInteractive`
 * strategy — Next.js's own dedicated mechanism for exactly this "run
 * before hydration" use case — rather than a raw `<script>` element: a
 * raw script tag rendered from React hit a real, intermittent crash under
 * this project's exact Next.js 16 (Turbopack) + React 19.2 combination
 * ("Encountered a script tag while rendering React component", blanking
 * some pages but not others). `next-themes`' own internal script
 * injection hit the identical crash, which is why theming here is
 * dependency-free instead. See ThemeProvider/useTheme in
 * theme-provider.tsx for the toggle half.
 */
export function ThemeScript() {
  return (
    // The `no-before-interactive-script-outside-document` rule predates
    // App Router support and false-positives here — `beforeInteractive` in
    // `app/layout.tsx` is Next.js's own documented App Router pattern.
    // eslint-disable-next-line @next/next/no-before-interactive-script-outside-document
    <Script
      id="theme-init"
      strategy="beforeInteractive"
      dangerouslySetInnerHTML={{
        __html:
          "(function(){try{var t=localStorage.getItem('theme');" +
          "var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);" +
          "if(d)document.documentElement.classList.add('dark');" +
          "}catch(e){}})();",
      }}
    />
  );
}
