import type { Metadata } from "next";
import { Suspense } from "react";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeScript } from "@/components/theme-script";
import { LoginTransitionProvider } from "@/components/preloader/login-transition-provider";
import { TopProgressBar } from "@/components/top-progress-bar";
import { env } from "@/lib/env";
import { buildRootMetadata } from "@/lib/site-metadata";
import "./globals.css";

// THE one place the UI typeface is chosen (Soft UI redesign: Inter). It is
// exposed as `--font-sans`; globals.css maps `font-sans` and `--font-heading`
// to it, so changing the family here changes it everywhere. One family for
// body and headings — weight and size carry the hierarchy.
const uiFont = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

// Branding for the browser tab, home-screen shortcuts and shared-link
// previews — see src/lib/site-metadata.ts. Route pages keep overriding
// `title` as before; the Open Graph/Twitter block below is inherited.
export const metadata: Metadata = buildRootMetadata(env.APP_URL);

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={uiFont.variable} suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeScript />
        <ThemeProvider>
          <Suspense fallback={null}>
            <TopProgressBar />
          </Suspense>
          <LoginTransitionProvider>
            {children}
            <Toaster />
          </LoginTransitionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
