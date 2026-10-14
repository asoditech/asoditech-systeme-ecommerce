"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="hidden sm:inline-flex size-10 rounded-full border border-hairline bg-shell text-ink-secondary shadow-soft hover:bg-nav-hover hover:text-ink sm:size-11"
      aria-label="Changer de thème"
      title="Changer de thème"
      disabled={!theme}
      onClick={toggleTheme}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
