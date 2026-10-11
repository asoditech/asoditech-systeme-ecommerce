"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { EXPLANATION_UI, type ExplanationLang } from "@/lib/metrics/analytics-explanations";

/**
 * Language of the analytics EXPLANATIONS only (« ⓘ » popovers, the
 * « Définitions des indicateurs » panel, the reference page). A per-viewer
 * convenience kept in localStorage (in memory if storage is blocked) and
 * shared by every analytics tab. It never touches `<html lang/dir>`, the
 * rest of the UI, any query or any export: French is the default and the
 * server always renders French.
 */

const KEY = "asoditech.analytics.explanationLang";
const EVENT = "asoditech:explanation-lang";
let memory: ExplanationLang = "fr";

function read(): ExplanationLang {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === "ar" || v === "fr") return v;
  } catch {
    // storage blocked — fall back to memory
  }
  return memory;
}

export function setExplanationLanguage(lang: ExplanationLang): void {
  memory = lang;
  try {
    window.localStorage.setItem(KEY, lang);
  } catch {
    // storage blocked — memory only
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useExplanationLanguage(): ExplanationLang {
  return useSyncExternalStore(subscribe, read, () => "fr");
}

const OPTIONS: { value: ExplanationLang; label: string }[] = [
  { value: "fr", label: "Français" },
  { value: "ar", label: "العربية" },
];

/** « Français | العربية » — two real buttons (aria-pressed), keyboard reachable. */
export function ExplanationLanguageToggle({ className }: { className?: string }) {
  const lang = useExplanationLanguage();
  return (
    <div role="group" aria-label={EXPLANATION_UI.toggleLabel} className={cn("inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5", className)}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          lang={o.value}
          aria-pressed={lang === o.value}
          onClick={() => setExplanationLanguage(o.value)}
          className={cn(
            "rounded-full px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            lang === o.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
