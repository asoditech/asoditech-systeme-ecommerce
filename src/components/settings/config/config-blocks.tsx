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
import { SettingInfo } from "@/components/settings/setting-info";
import type { SettingId } from "@/lib/settings/settings-explanations";
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
        className={percent === 100 ? "stroke-success" : "stroke-brand"}
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
  const stats: { icon: LucideIcon; value: string; label: string; tone: string; info: SettingId }[] = [
    {
      icon: CheckCircle2,
      value: `${health.sectionsOk}/${health.sections}`,
      label: "sections en ordre",
      info: "sectionsInOrder",
      tone: health.sectionsOk === health.sections ? "bg-pill-green text-pill-green-fg" : "bg-pill-neutral text-ink",
    },
    {
      icon: AlertTriangle,
      value: String(health.attention),
      label: health.attention === 1 ? "point à vérifier" : "points à vérifier",
      info: "pointsToCheck",
      tone: health.attention > 0 ? "bg-pill-yellow text-pill-yellow-fg" : "bg-pill-neutral text-ink-secondary",
    },
    {
      icon: ToggleRight,
      value: `${health.switchesOn}/${health.switchesTotal}`,
      label: "fonctions activées",
      info: "featuresOn",
      tone: "bg-pill-peach text-pill-peach-fg",
    },
  ];
  return (
    <section aria-label="Centre de contrôle" className="relative overflow-hidden rounded-card bg-card shadow-card">
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
              <p className="text-xs font-medium text-ink-muted">Centre de contrôle</p>
              <h2 className="truncate text-xl font-semibold tracking-tight text-ink sm:text-2xl">{companyName.trim() || "Votre entreprise"}</h2>
              <p className="flex items-center gap-1 text-sm text-muted-foreground">
                Pilotez le fonctionnement de votre activité · identité complète à {completion} %
                <SettingInfo setting="identityCompletion" />
              </p>
            </div>
          </div>
          <ConfigSearch index={index} currentSection={section} />
        </div>
        <ul className="grid gap-2 sm:grid-cols-3">
          {stats.map((s) => (
            <li key={s.label} className="flex items-center gap-3 rounded-xl border border-hairline bg-card px-3.5 py-2.5 backdrop-blur">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", s.tone)}>
                <s.icon className="size-4" />
              </span>
              <p className="min-w-0 text-sm">
                <span className="font-bold tabular-nums">{s.value}</span> <span className="text-muted-foreground">{s.label}</span>
              </p>
              <SettingInfo setting={s.info} label={s.label} className="ml-auto" />
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
      <ul className="flex gap-1 overflow-x-auto rounded-full bg-segment-track p-1 [scrollbar-width:none]">
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
                  "flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25",
                  active ? "bg-segment-thumb text-ink shadow-soft" : "text-ink-secondary hover:text-ink"
                )}
              >
                <Icon className={cn("size-4", active ? accent.text : "")} />
                {s.short}
                {flagged.includes(s.id) && <span className="size-1.5 rounded-full bg-chart-5" aria-label="à vérifier" />}
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
          <li key={`${a.section}-${a.title}`} className="relative flex items-start gap-3 overflow-hidden rounded-tile bg-pill-yellow/60 p-4 pl-5">
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-chart-5" />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-pill-yellow text-pill-yellow-fg">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{a.title}</p>
              <p className="text-sm text-muted-foreground">{a.message}</p>
            </div>
            <Link
              href={sectionHref(a.section, a.anchor)}
              className="inline-flex shrink-0 items-center gap-1 self-center rounded-full bg-card px-3 py-1.5 text-xs font-semibold text-ink shadow-soft transition-colors hover:bg-row-hover"
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
        "group relative flex flex-col overflow-hidden rounded-card bg-card p-5 shadow-card transition-all hover:shadow-popover hover:ring-1 focus-visible:ring-2 focus-visible:outline-none",
        accent.hoverRing
      )}
    >
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-x-0 top-0 h-24 bg-linear-to-b opacity-80", accent.wash)} />
      <div className="relative flex items-start justify-between gap-3">
        <span className={cn("flex size-11 items-center justify-center rounded-xl", accent.chip)}>
          <Icon className="size-5" />
        </span>
        {summary.attention > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-pill-yellow px-2 py-0.5 text-xs font-semibold text-pill-yellow-fg">
            <AlertTriangle className="size-3" />
            {summary.attention} à vérifier
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-pill-green-fg">
            <CheckCircle2 className="size-3.5" />
            En ordre
          </span>
        )}
      </div>
      <div className="relative mt-4">
        <h3 className="text-base font-semibold tracking-tight">{meta.label}</h3>
        <p className="text-sm text-muted-foreground">{meta.purpose}</p>
      </div>
      <div className="relative mt-4 rounded-xl bg-pill-neutral px-3.5 py-3">
        <p className={cn("truncate text-lg font-semibold tracking-tight", accent.text)}>{summary.value}</p>
        <p className="truncate text-xs text-muted-foreground">{summary.caption}</p>
      </div>
      {summary.switches.length > 0 && (
        <ul className="relative mt-3 space-y-1.5">
          {summary.switches.map((sw) => (
            <li key={sw.label} className="flex items-center gap-2 text-xs">
              <span className={cn("size-2 shrink-0 rounded-full", sw.on ? "bg-success" : "border border-muted-foreground/50")} />
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
    <header className="relative overflow-hidden rounded-card bg-card px-5 py-5 shadow-card sm:px-6">
      <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0 bg-linear-to-r", accent.wash)} />
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-1", accent.bar)} />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-full", accent.chip)}>
            <Icon className="size-6" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight">{meta.label}</h2>
            <p className="text-sm text-muted-foreground">{meta.purpose}</p>
          </div>
        </div>
        <div className="flex shrink-0 gap-2 text-xs">
          <span className="rounded-full bg-pill-neutral px-3 py-1.5 font-medium text-ink">
            {settingsCount} réglage{settingsCount > 1 ? "s" : ""}
          </span>
          {switchesTotal > 0 && (
            <span className="rounded-full bg-pill-neutral px-3 py-1.5 font-medium text-ink">
              {switchesOn}/{switchesTotal} activé{switchesOn > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

/** A switch shown read-only (the user may see it but not change it). */
export function ReadOnlyStateTile({ icon: Icon, title, on, note, info }: { icon: LucideIcon; title: string; on: boolean; note: string; info?: React.ReactNode }) {
  return (
    <article className="flex flex-col rounded-card border border-dashed border-field-border bg-card/60 p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-pill-neutral text-ink-secondary">
          <Icon className="size-5" />
        </span>
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold", on ? "text-pill-green-fg" : "text-muted-foreground")}>
          <span className={cn("size-2 rounded-full", on ? "bg-success" : "border border-muted-foreground/50")} />
          {on ? "Activé" : "Désactivé"}
        </span>
      </div>
      <div className="mt-4 flex items-start gap-1">
        <h4 className="text-[15px] font-semibold tracking-tight">{title}</h4>
        {info}
      </div>
      <p className="mt-auto flex items-center gap-1.5 pt-3 text-xs text-muted-foreground">
        <Lock className="size-3.5" />
        {note}
      </p>
    </article>
  );
}

/** A setting the user can't use here (mode off, missing permission, nothing connected). */
export function UnavailableTile({
  icon: Icon,
  title,
  message,
  action,
  info,
}: {
  icon: LucideIcon;
  title: string;
  message: string;
  action?: { href: string; label: string };
  info?: React.ReactNode;
}) {
  return (
    <article className="flex flex-col items-start rounded-card border border-dashed border-field-border p-5">
      <span className="flex size-10 items-center justify-center rounded-full bg-pill-neutral text-ink-secondary">
        <Icon className="size-5" />
      </span>
      <div className="mt-4 flex items-start gap-1">
        <h4 className="text-[15px] font-semibold tracking-tight">{title}</h4>
        {info}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {action && (
        <Link href={action.href} className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-link">
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
      className="group flex min-w-0 items-center gap-3 rounded-tile bg-card px-4 py-3 shadow-card transition-all hover:shadow-popover focus-visible:ring-2 focus-visible:outline-none"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-pill-neutral text-ink-secondary transition-colors group-hover:bg-pill-peach group-hover:text-pill-peach-fg">
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
