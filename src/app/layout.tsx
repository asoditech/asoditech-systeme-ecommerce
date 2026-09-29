import type { Metadata } from "next";
import { Suspense } from "react";
import { Montserrat } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeScript } from "@/components/theme-script";
import { LoginTransitionProvider } from "@/components/preloader/login-transition-provider";
import { TopProgressBar } from "@/components/top-progress-bar";
import "./globals.css";

// UI/UX refinement phase (2026-09): Montserrat replaces Inter as the
// primary UI typeface — modern, clean, strong hierarchy without oversized
// type. One family for both body and headings (`--font-heading` in
// globals.css still just aliases this), so weight/size alone carries the
// hierarchy instead of switching typefaces.
const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ASODITECH — Gestion E-commerce",
  description: "Système de gestion e-commerce ASODITECH.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={montserrat.variable} suppressHydrationWarning>
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
