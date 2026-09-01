import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeScript } from "@/components/theme-script";
import { LoginTransitionProvider } from "@/components/preloader/login-transition-provider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ASODITECH — Gestion E-commerce",
  description: "Système de gestion e-commerce ASODITECH.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={inter.variable} suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeScript />
        <ThemeProvider>
          <LoginTransitionProvider>
            {children}
            <Toaster />
          </LoginTransitionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
