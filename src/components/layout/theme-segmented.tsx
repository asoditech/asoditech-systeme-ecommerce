"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

/**
 * Light / Dark pill at the bottom of the sidebar (Soft UI). Same mechanism as
 * the topbar toggle: the `dark` class on <html> + localStorage (theme-provider).
 * `compact`: icon-only, for the collapsed rail.
 */
export function ThemeSegmented({ compact = false }: { compact?: boolean }) {
  const { theme, setTheme } = useTheme();
  if (compact) {
    const next = theme === "dark" ? "light" : "dark";
    const Icon = theme === "dark" ? Moon : Sun;
    return (
      <button
        type="button"
        disabled={!theme}
        onClick={() => setTheme(next)}
        aria-label={next === "dark" ? "Passer au thème sombre" : "Passer au thème clair"}
        title={next === "dark" ? "Thème sombre" : "Thème clair"}
        className="flex size-11 items-center justify-center rounded-control text-ink-secondary transition-colors duration-150 hover:bg-nav-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Icon className="size-5" aria-hidden="true" />
      </button>
    );
  }
  const options = [
    { value: "light" as const, label: "Clair", Icon: Sun },
    { value: "dark" as const, label: "Sombre", Icon: Moon },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Thème"
      className="flex gap-1 rounded-control bg-nav-hover p-1"
    >
      {options.map(({ value, label, Icon }) => {
        const selected = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!theme}
            onClick={() => setTheme(value)}
            className={cn(
              "flex h-9 flex-1 items-center justify-center gap-2 rounded-[0.7rem] text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring",
              selected ? "bg-shell text-ink shadow-soft" : "text-ink-secondary hover:text-ink"
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
