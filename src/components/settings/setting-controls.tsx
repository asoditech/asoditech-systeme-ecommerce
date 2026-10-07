"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { Check, Loader2, Pencil, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { SECTION_ACCENTS } from "@/components/settings/config/section-meta";
import type { ConfigSectionId } from "@/lib/settings/configuration-model";
import type { ActionResult } from "@/actions/types";

/**
 * Interactive building blocks of the Configuration control center. Every
 * save goes through the setting's EXISTING server action; only presentation
 * lives here.
 *
 * Save rule, everywhere:
 *  - a SWITCH applies immediately (pending state, success toast, reverts on error);
 *  - a VALUE tile opens an inline editor with its own Annuler / Enregistrer;
 *  - a multi-field FORM shows a floating save bar once something changed
 *    (Annuler restores the saved values; the browser warns before leaving).
 */

type FormAction = (formData: FormData) => Promise<ActionResult<unknown>>;

/** ● Activé / ○ Désactivé — the state, readable before any text. */
export function StateIndicator({ on, pending = false }: { on: boolean; pending?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold",
        on ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
      )}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <span className={cn("size-2 rounded-full", on ? "bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/20" : "border border-muted-foreground/50")} />
      )}
      {on ? "Activé" : "Désactivé"}
    </span>
  );
}

/**
 * A switch setting as a tile: icon, title, the state in large, one line of
 * consequence, the switch. Saves immediately through `save`.
 */
export function ToggleTile({
  anchor,
  section,
  icon: Icon,
  title,
  summary,
  detail,
  note,
  checked,
  save,
  onMessage,
  offMessage,
}: {
  anchor: string;
  section: ConfigSectionId;
  icon: LucideIcon;
  title: string;
  /** One line: what it does. */
  summary: string;
  /** What changes when on / off — shown under the summary. */
  detail?: string;
  /** Permission / safety note. */
  note?: string;
  checked: boolean;
  save: (next: boolean) => Promise<ActionResult<unknown>>;
  onMessage: string;
  offMessage: string;
}) {
  const router = useRouter();
  const accent = SECTION_ACCENTS[section];
  const [value, setValue] = useState(checked);
  const [isPending, startTransition] = useTransition();
  const switchId = `${anchor}-switch`;

  function change(next: boolean) {
    setValue(next);
    startTransition(async () => {
      const r = await save(next);
      if (r.ok) {
        toast.success(next ? onMessage : offMessage);
        router.refresh();
      } else {
        setValue(!next);
        toast.error(r.error);
      }
    });
  }

  return (
    <article
      id={anchor}
      className={cn(
        "group relative flex scroll-mt-24 flex-col overflow-hidden rounded-2xl border bg-card p-5 shadow-xs transition-all data-flash:ring-2 data-flash:ring-primary/50",
        value ? cn("border-transparent ring-1", accent.ring) : "border-border",
      )}
    >
      {value && <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0 bg-linear-to-br opacity-70", accent.wash)} />}
      <div className="relative flex items-start justify-between gap-4">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", accent.chip)}>
          <Icon className="size-5" />
        </span>
        <StateIndicator on={value} pending={isPending} />
      </div>
      <div className="relative mt-4 flex-1 space-y-1.5">
        <label htmlFor={switchId} className="block text-[15px] leading-snug font-semibold tracking-tight">
          {title}
        </label>
        <p className="text-sm text-muted-foreground">{summary}</p>
        {detail && <p className="text-xs leading-relaxed text-muted-foreground/90">{detail}</p>}
      </div>
      <div className="relative mt-5 flex items-center justify-between gap-3 border-t border-border/60 pt-4">
        <p className="min-w-0 text-xs text-muted-foreground">{note ?? (value ? "S'applique immédiatement" : "Sans effet tant que désactivé")}</p>
        <Switch id={switchId} aria-label={title} checked={value} disabled={isPending} onCheckedChange={(v) => change(v === true)} className="scale-110" />
      </div>
    </article>
  );
}

/** Adapts a FormData action (`{ [name]: "true"|"false" }`) to ToggleTile's `save`. */
export function formSwitch(action: FormAction, name: string) {
  return (next: boolean) => {
    const fd = new FormData();
    fd.set(name, next ? "true" : "false");
    return action(fd);
  };
}

/**
 * A value setting as a tile: the current value shown big (a preview of what
 * it produces), « Modifier » opens an inline editor (`children`: the real
 * fields, same names as before) with its own Annuler / Enregistrer.
 */
export function ValueTile({
  anchor,
  section,
  icon: Icon,
  title,
  summary,
  value,
  valueCaption,
  note,
  action,
  success,
  children,
  wide = false,
}: {
  anchor: string;
  section: ConfigSectionId;
  icon: LucideIcon;
  title: string;
  summary: string;
  value: React.ReactNode;
  valueCaption?: string;
  note?: string;
  action: FormAction;
  success: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const router = useRouter();
  const accent = SECTION_ACCENTS[section];
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const r = await action(fd);
      if (r.ok) {
        toast.success(success);
        setEditing(false);
        router.refresh();
      } else {
        const fieldError = r.fieldErrors ? Object.values(r.fieldErrors).flat().find(Boolean) : null;
        setError(fieldError ?? r.error);
      }
    });
  }

  return (
    <article
      id={anchor}
      className={cn(
        "relative flex scroll-mt-24 flex-col overflow-hidden rounded-2xl border bg-card p-5 shadow-xs transition-shadow data-flash:ring-2 data-flash:ring-primary/50",
        wide && "md:col-span-2",
        editing && cn("ring-2", accent.ring)
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", accent.chip)}>
          <Icon className="size-5" />
        </span>
        {!editing && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} aria-label={`Modifier : ${title}`}>
            <Pencil className="size-3.5" />
            Modifier
          </Button>
        )}
      </div>
      <div className="mt-4 space-y-1">
        <h4 className="text-[15px] leading-snug font-semibold tracking-tight">{title}</h4>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>

      {editing ? (
        <form onSubmit={submit} className="mt-4 space-y-4">
          {children}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => { setEditing(false); setError(null); }} disabled={isPending}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Enregistrer
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-4 flex flex-1 flex-col justify-end">
          <div className="rounded-xl bg-muted/50 px-4 py-3">
            <div className={cn("text-xl font-semibold tracking-tight break-words", accent.text)}>{value}</div>
            {valueCaption && <p className="mt-0.5 text-xs text-muted-foreground">{valueCaption}</p>}
          </div>
          {note && <p className="mt-3 text-xs text-muted-foreground">{note}</p>}
        </div>
      )}
    </article>
  );
}

/** One choice of a radio-card group (native radio input: keyboard + form friendly). */
export function ChoiceCard({
  name,
  value,
  defaultChecked,
  title,
  description,
}: {
  name: string;
  value: string;
  defaultChecked: boolean;
  title: string;
  description?: string;
}) {
  return (
    <label className="group relative flex cursor-pointer items-start gap-3 rounded-xl border bg-background p-3.5 transition-colors hover:bg-muted/40 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-2 has-focus-visible:ring-ring/35">
      <input type="radio" name={name} value={value} defaultChecked={defaultChecked} className="peer sr-only" />
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 peer-checked:border-primary peer-checked:bg-primary">
        <span className="size-1.5 rounded-full bg-primary-foreground opacity-0 peer-checked:opacity-100 group-has-checked:opacity-100" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        {description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}
      </span>
    </label>
  );
}

/**
 * A multi-field form whose save bar floats in once a field changed.
 * Uncontrolled fields are tracked through the form's input events; Annuler
 * remounts the fields (restoring saved values, controlled ones included).
 */
export function SettingsForm({
  action,
  success,
  children,
  className,
}: {
  action: FormAction;
  success: string;
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const r = await action(fd);
      if (r.ok) {
        toast.success(success);
        setDirty(false);
        router.refresh();
      } else {
        const fieldError = r.fieldErrors ? Object.values(r.fieldErrors).flat().find(Boolean) : null;
        setError(fieldError ?? r.error);
        toast.error(r.error);
      }
    });
  }

  function cancel() {
    formRef.current?.reset();
    setResetKey((k) => k + 1);
    setDirty(false);
    setError(null);
  }

  return (
    <form ref={formRef} onSubmit={submit} onInput={() => setDirty(true)} onChange={() => setDirty(true)} className={className} data-state={dirty ? "dirty" : "clean"}>
      <div key={resetKey}>{children}</div>
      {/* Room for the floating bar, so it never covers the last fields. */}
      {dirty && <div aria-hidden="true" className="h-20" />}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <AnimatePresence>
        {dirty && (
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-x-3 bottom-4 z-40 mx-auto flex max-w-xl flex-col gap-3 rounded-2xl bg-foreground px-4 py-3 text-background shadow-2xl sm:flex-row sm:items-center"
            role="region"
            aria-label="Modifications non enregistrées"
          >
            <p className="flex items-center gap-2 text-sm font-medium sm:mr-auto">
              <span className="size-2 rounded-full bg-amber-400" />
              Modifications non enregistrées
            </p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={cancel} disabled={isPending} className="flex-1 text-background hover:bg-background/10 hover:text-background sm:flex-none">
                Annuler
              </Button>
              <Button type="submit" disabled={isPending} className="flex-1 sm:flex-none">
                {isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Enregistrer
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}
