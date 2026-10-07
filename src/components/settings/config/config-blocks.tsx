import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Lock,
  SlidersHorizontal,
  ToggleRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SECTION_ACCENTS } from "@/components/settings/config/section-meta";
import { ConfigSearch } from "@/components/settings/config/config-search";
import {
  CONFIG_SECTIONS,
  sectionHref,
  type AttentionItem,
  type ConfigHealth,
  type ConfigSectionId,
  type SectionSummary,
  type SettingIndexEntry,
} from "@/lib/settings/configuration-model";

/**
 * Server-rendered blocks of the Configuration control center: hero, section
 * navigation, attention cards, section tiles and the small static tiles.
 * Purely presentational — no setting is read or written here.
 */

/** Circular completion meter (SVG), e.g. identity completeness. */
export function CompletionRing({ percent, size = 44 }: { percent: number; size?: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 44 44" width={size} height={size} role="img" aria-label={`${percent} %`} className="shrink-0 -rotate-90">
      <circle cx="22" cy="22" r={r} fill="none" strokeWidth="4" className="stroke-muted" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - percent / 100)}
        className={percent === 100 ? "stroke-emerald-500" : "stroke-primary"}
      />
    </svg>
  );
}

export function ConfigHero({
  companyName,
  logoUrl,
  completion,
  health,
  index,
  section,
}: {
  companyName: string;
  logoUrl: string | null;
  completion: number;
  health: ConfigHealth;
  index: SettingIndexEntry[];
  section: ConfigSectionId;
}) {
  const initials = companyName.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
  const stats: { icon: LucideIcon; value: string; label: string; tone: string }[] = [
    {
      icon: CheckCircle2,
      value: `${health.sectionsOk}/${health.sections}`,
      label: "sections en ordre",
      tone: health.sectionsOk === health.sections ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" : "bg-muted text-foreground",
    },
    {
      icon: AlertTriangle,
      value: String(health.attention),
      label: health.attention === 1 ? "point à vérifier" : "points à vérifier",
      tone: health.attention > 0 ? "bg-amber-500/12 text-amber-600 dark:text-amber-400" : "bg-muted text-muted-foreground",
    },
    {
      icon: ToggleRight,
      value: `${health.switchesOn}/${health.switchesTotal}`,
      label: "fonctions activées",
      tone: "bg-primary/12 text-primary",
    },
  ];
  return (
    <section aria-label="Centre de contrôle" className="relative overflow-hidden rounded-2xl bg-card shadow-card ring-1 ring-border">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-linear-to-br from-primary/10 via-primary/3 to-transparent" />
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-primary" />
      <div className="relative flex flex-col gap-6 p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="relative shrink-0">
              <CompletionRing percent={completion} size={64} />
              <span className="absolute inset-[9px] flex items-center justify-center overflow-hidden rounded-full bg-background text-sm font-bold">
                {logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  initials
                )}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-wide text-accent-foreground uppercase">Centre de contrôle</p>
              <h2 className="truncate text-xl font-bold tracking-tight sm:text-2xl">{companyName.trim() || "Votre entreprise"}</h2>
              <p className="text-sm text-muted-foreground">Pilotez le fonctionnement de votre activité · identité complète à {completion} %</p>
            </div>
          </div>
          <ConfigSearch index={index} currentSection={section} />
        </div>
        <ul className="grid gap-2 sm:grid-cols-3">
          {stats.map((s) => (
            <li key={s.label} className="flex items-center gap-3 rounded-xl border border-border/70 bg-background/70 px-3.5 py-2.5 backdrop-blur">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", s.tone)}>
                <s.icon className="size-4" />
              </span>
              <p className="min-w-0 text-sm">
                <span className="font-bold tabular-nums">{s.value}</span> <span className="text-muted-foreground">{s.label}</span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Pill navigation with an icon per section; scrolls sideways on phones. */
export function ConfigNav({ current, flagged }: { current: ConfigSectionId; flagged: ConfigSectionId[] }) {
  return (
    <nav aria-label="Sections de la configuration" className="min-w-0">
      <ul className="flex gap-1 overflow-x-auto rounded-2xl bg-muted/60 p-1 [scrollbar-width:none]">
        {CONFIG_SECTIONS.map((s) => {
          const active = s.id === current;
          const accent = SECTION_ACCENTS[s.id];
          const Icon = accent.icon;
          return (
            <li key={s.id} className="shrink-0">
              <Link
                href={sectionHref(s.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-10 items-center gap-2 rounded-xl px-3.5 text-sm font-medium whitespace-nowrap transition-all",
                  active ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                )}
              >
                <Icon className={cn("size-4", active ? accent.text : "")} />
                {s.short}
                {flagged.includes(s.id) && <span className="size-1.5 rounded-full bg-amber-500" aria-label="à vérifier" />}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Compact, actionable attention cards — genuine gaps only. */
export function AttentionCards({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="À corriger">
      {items.map((a) => {
        const Icon = SECTION_ACCENTS[a.section].icon;
        return (
          <li key={`${a.section}-${a.title}`} className="relative flex items-start gap-3 overflow-hidden rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 pl-5">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-amber-500" />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{a.title}</p>
              <p className="text-sm text-muted-foreground">{a.message}</p>
            </div>
            <Link
              href={sectionHref(a.section, a.anchor)}
              className="inline-flex shrink-0 items-center gap-1 self-center rounded-lg bg-background px-2.5 py-1.5 text-xs font-semibold shadow-xs ring-1 ring-border transition-colors hover:bg-muted"
            >
              Corriger
              <ArrowRight className="size-3.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Overview tile: identity, key value, switch states, attention — the whole tile opens the section. */
export function SectionTile({ summary, settingsCount }: { summary: SectionSummary; settingsCount: number }) {
  const meta = CONFIG_SECTIONS.find((s) => s.id === summary.id)!;
  const accent = SECTION_ACCENTS[summary.id];
  const Icon = accent.icon;
  return (
    <Link
      href={sectionHref(summary.id)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-2xl border bg-card p-5 shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md hover:ring-1 focus-visible:ring-2 focus-visible:outline-none",
        accent.hoverRing
      )}
    >
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 top-0 h-24 bg-linear-to-b opacity-80", accent.wash)} />
      <div className="relative flex items-start justify-between gap-3">
        <span className={cn("flex size-11 items-center justify-center rounded-xl", accent.chip)}>
          <Icon className="size-5" />
        </span>
        {summary.attention > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/12 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-3" />
            {summary.attention} à vérifier
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            En ordre
          </span>
        )}
      </div>
      <div className="relative mt-4">
        <h3 className="text-base font-semibold tracking-tight">{meta.label}</h3>
        <p className="text-sm text-muted-foreground">{meta.purpose}</p>
      </div>
      <div className="relative mt-4 rounded-xl bg-muted/50 px-3.5 py-3">
        <p className={cn("truncate text-lg font-bold tracking-tight", accent.text)}>{summary.value}</p>
        <p className="truncate text-xs text-muted-foreground">{summary.caption}</p>
      </div>
      {summary.switches.length > 0 && (
        <ul className="relative mt-3 space-y-1.5">
          {summary.switches.map((sw) => (
            <li key={sw.label} className="flex items-center gap-2 text-xs">
              <span className={cn("size-2 shrink-0 rounded-full", sw.on ? "bg-emerald-500" : "border border-muted-foreground/50")} />
              <span className={cn("truncate", sw.on ? "text-foreground" : "text-muted-foreground")}>{sw.label}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="relative mt-auto flex items-center justify-between pt-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <SlidersHorizontal className="size-3.5" />
          {settingsCount} réglage{settingsCount > 1 ? "s" : ""}
        </span>
        <span className="inline-flex items-center gap-1 font-semibold text-foreground transition-transform group-hover:translate-x-0.5">
          Ouvrir
          <ArrowRight className="size-3.5" />
        </span>
      </div>
    </Link>
  );
}

/** The header band of a section workspace. */
export function SectionHeader({
  id,
  settingsCount,
  switchesOn,
  switchesTotal,
}: {
  id: Exclude<ConfigSectionId, "apercu">;
  settingsCount: number;
  switchesOn: number;
  switchesTotal: number;
}) {
  const meta = CONFIG_SECTIONS.find((s) => s.id === id)!;
  const accent = SECTION_ACCENTS[id];
  const Icon = accent.icon;
  return (
    <header className="relative overflow-hidden rounded-2xl border bg-card px-5 py-5 shadow-xs sm:px-6">
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0 bg-linear-to-r", accent.wash)} />
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", accent.bar)} />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl", accent.chip)}>
            <Icon className="size-6" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight">{meta.label}</h2>
            <p className="text-sm text-muted-foreground">{meta.purpose}</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2 text-xs">
          <span className="rounded-lg bg-background/80 px-2.5 py-1.5 font-medium shadow-xs ring-1 ring-border">
            {settingsCount} réglage{settingsCount > 1 ? "s" : ""}
          </span>
          {switchesTotal > 0 && (
            <span className="rounded-lg bg-background/80 px-2.5 py-1.5 font-medium shadow-xs ring-1 ring-border">
              {switchesOn}/{switchesTotal} activé{switchesOn > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

/** A switch shown read-only (the user may see it but not change it). */
export function ReadOnlyStateTile({ icon: Icon, title, on, note }: { icon: LucideIcon; title: string; on: boolean; note: string }) {
  return (
    <article className="flex flex-col rounded-2xl border border-dashed bg-card/60 p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", on ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          <span className={cn("size-2 rounded-full", on ? "bg-emerald-500" : "border border-muted-foreground/50")} />
          {on ? "Activé" : "Désactivé"}
        </span>
      </div>
      <h4 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h4>
      <p className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted-foreground">
        <Lock className="size-3.5" />
        {note}
      </p>
    </article>
  );
}

/** A setting the user can't use here (mode off, missing permission, nothing connected). */
export function UnavailableTile({ icon: Icon, title, message, action }: { icon: LucideIcon; title: string; message: string; action?: { href: string; label: string } }) {
  return (
    <article className="flex flex-col items-start rounded-2xl border border-dashed bg-muted/20 p-5">
      <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <h4 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {action && (
        <Link href={action.href} className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
          {action.label}
          <ArrowUpRight className="size-3.5" />
        </Link>
      )}
    </article>
  );
}

/** A dedicated management page (advanced configuration lives there). */
export function DedicatedLink({ href, icon: Icon, title, description }: { href: string; icon: LucideIcon; title: string; description: string }) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs transition-all hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:outline-none"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground/80 transition-colors group-hover:bg-primary/12 group-hover:text-primary">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{description}</span>
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
    </Link>
  );
}
