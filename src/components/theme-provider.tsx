"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
interface ThemeContextValue {
  /** undefined until mounted (avoids a hydration mismatch — see theme-toggle.tsx). */
  theme: Theme | undefined;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: undefined, toggleTheme: () => {} });

/**
 * Minimal theme context — see theme-script.tsx for why this doesn't use
 * `next-themes`. Reads the class ThemeScript already applied to <html> on
 * mount (no flash), and toggles + persists it from here.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme | undefined>(undefined);

  // Deliberately deferred to a post-mount effect, not a useState lazy
  // initializer: the server render always has no `theme` (no DOM to read),
  // so the first client render must match that exactly to avoid a
  // hydration mismatch — only the second render (this effect) may diverge.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.classList.toggle("dark", next === "dark");
      try {
        localStorage.setItem("theme", next);
      } catch {
        // localStorage can throw in private-browsing/blocked-storage contexts — theme just won't persist.
      }
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
