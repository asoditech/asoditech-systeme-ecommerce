"use client";

import * as React from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { dayParam, linkedDayBounds } from "@/lib/date-range-query";

/**
 * The ONE « Du / Au » control of the app (filters on reports, analytics,
 * finance, orders, expenses, delivery, product export…). Native date inputs
 * — the device's own accessible, localized calendar on desktop and mobile —
 * grouped in a single bordered control with visible, associated labels and
 * linked bounds (« Au » can't be picked before « Du »).
 *
 * Works two ways:
 *  - inside a GET `<form>`: the inputs carry `fromName` / `toName`, so the
 *    page's URL params are exactly what they were;
 *  - controlled by a client filter through `onChange`.
 *
 * Re-keyed on the incoming values: after a soft navigation (a preset link,
 * « Réinitialiser ») the fields always show the URL's range, never a value
 * typed before (the former `defaultValue` inputs kept stale text).
 */
export interface DateRangeFieldsProps {
  idPrefix: string;
  from?: string | null;
  to?: string | null;
  fromName?: string;
  toName?: string;
  fromLabel?: string;
  toLabel?: string;
  /** Longer accessible names when the visible « Du » / « Au » need context. */
  fromAriaLabel?: string;
  toAriaLabel?: string;
  required?: boolean;
  size?: "sm" | "default";
  className?: string;
  onChange?: (range: { from: string; to: string }) => void;
}

export function DateRangeFields(props: DateRangeFieldsProps) {
  return <DateRangeFieldsInner key={`${dayParam(props.from)}|${dayParam(props.to)}`} {...props} />;
}

function DateRangeFieldsInner({
  idPrefix,
  from: initialFrom,
  to: initialTo,
  fromName,
  toName,
  fromLabel = "Du",
  toLabel = "Au",
  fromAriaLabel,
  toAriaLabel,
  required,
  size = "default",
  className,
  onChange,
}: DateRangeFieldsProps) {
  const [from, setFrom] = React.useState(dayParam(initialFrom));
  const [to, setTo] = React.useState(dayParam(initialTo));
  const { fromMax, toMin } = linkedDayBounds(from, to);
  const inputClass = cn(
    "min-w-0 bg-transparent tabular-nums outline-none [color-scheme:light] dark:[color-scheme:dark]",
    "rounded-md px-1.5 focus-visible:ring-2 focus-visible:ring-ring/50",
    size === "sm" ? "h-7 text-sm" : "h-8 text-sm"
  );

  return (
    <div
      role="group"
      aria-label={`${fromLabel} – ${toLabel}`}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-x-1 gap-y-1 rounded-lg border border-input bg-background px-2 shadow-xs",
        "focus-within:border-ring",
        size === "sm" ? "py-0.5" : "py-1",
        className
      )}
    >
      <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <label htmlFor={`${idPrefix}-from`} className="text-xs font-medium text-muted-foreground">
        {fromLabel}
      </label>
      <input
        id={`${idPrefix}-from`}
        type="date"
        name={fromName}
        value={from}
        max={fromMax}
        required={required}
        aria-label={fromAriaLabel}
        onChange={(e) => {
          setFrom(e.target.value);
          onChange?.({ from: e.target.value, to });
        }}
        className={inputClass}
      />
      <span className="text-muted-foreground" aria-hidden="true">
        →
      </span>
      <label htmlFor={`${idPrefix}-to`} className="text-xs font-medium text-muted-foreground">
        {toLabel}
      </label>
      <input
        id={`${idPrefix}-to`}
        type="date"
        name={toName}
        value={to}
        min={toMin}
        required={required}
        aria-label={toAriaLabel}
        onChange={(e) => {
          setTo(e.target.value);
          onChange?.({ from, to: e.target.value });
        }}
        className={inputClass}
      />
    </div>
  );
}
