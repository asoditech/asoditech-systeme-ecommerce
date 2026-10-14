"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
interface ThemeContextValue {
  /** undefined until mounted (avoids a hydration mismatch — see theme-toggle.tsx). */
  theme: Theme | undefined;
  toggleTheme: () => void;
  /** Explicit choice (the sidebar's Light / Dark segmented control) — same class + localStorage mechanism. */
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: undefined, toggleTheme: () => {}, setTheme: () => {} });

function applyTheme(next: Theme) {
  document.documentElement.classList.toggle("dark", next === "dark");
  try {
    localStorage.setItem("theme", next);
  } catch {
    // localStorage can throw in private-browsing/blocked-storage contexts — theme just won't persist.
  }
}

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
    // Safety net for responses where ThemeScript did not run before paint
    // (seen on notFound() pages, dev and production): re-apply the same rule
    // — only an explicit stored `theme=dark` makes the app dark.
    try {
      if (localStorage.getItem("theme") === "dark") document.documentElement.classList.add("dark");
    } catch {
      // Blocked storage: keep whatever class is already there.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  const chooseTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setTheme(next);
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme, setTheme: chooseTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
