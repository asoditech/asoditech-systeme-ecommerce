import { endOfZonedDay, parseZonedDay, zonedDayStartOffset, zonedInstant, zonedParts } from "@/lib/time/zoned";

/**
 * A common "date range" filter shape (Aujourd'hui/Hier/7 derniers jours/…
 * /Custom) reusable across any list page that wants one — first used by
 * /livraison. Deliberately generic (not delivery-specific) so another
 * page can adopt the same presets later without a rename.
 */
export type DateRangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "90d"
  | "this-month"
  | "last-month"
  | "all"
  | "custom";

export const DATE_RANGE_PRESET_LABELS: Record<DateRangePreset, string> = {
  today: "Aujourd'hui",
  yesterday: "Hier",
  "7d": "7 derniers jours",
  "30d": "30 derniers jours",
  "90d": "90 derniers jours",
  "this-month": "Ce mois",
  "last-month": "Le mois dernier",
  all: "Depuis le lancement",
  custom: "Période personnalisée",
};

export interface ResolvedDateRange {
  from?: Date;
  to?: Date;
}

/**
 * Resolves a preset (or an explicit custom from/to pair) to a concrete
 * `{ from, to }` — both ends inclusive, `undefined` meaning unbounded
 * ("all" has no lower bound; a custom range with only one side filled
 * leaves the other open). `custom` ignores `now` entirely and just
 * echoes back `customFrom`/`customTo` as whole days.
 *
 * Days are the BUSINESS time zone's days when `timeZone` is given (every
 * server caller passes getBusinessTimeZone()) — see src/lib/time/zoned.ts;
 * `undefined` keeps server-local days.
 */
export function resolveDateRangePreset(
  preset: DateRangePreset,
  now: Date = new Date(),
  custom?: { from?: string; to?: string },
  timeZone?: string
): ResolvedDateRange {
  const dayStart = (offset: number) => zonedDayStartOffset(now, offset, timeZone);
  const todayEnd = endOfZonedDay(now, timeZone);
  const p = zonedParts(now, timeZone);
  switch (preset) {
    case "today":
      return { from: dayStart(0), to: todayEnd };
    case "yesterday":
      return { from: dayStart(-1), to: new Date(dayStart(0).getTime() - 1) };
    case "7d":
      return { from: dayStart(-6), to: todayEnd };
    case "30d":
      return { from: dayStart(-29), to: todayEnd };
    case "90d":
      return { from: dayStart(-89), to: todayEnd };
    case "this-month":
      return { from: zonedInstant(timeZone, p.year, p.month, 1), to: todayEnd };
    case "last-month":
      return {
        from: zonedInstant(timeZone, p.year, p.month - 1, 1),
        to: new Date(zonedInstant(timeZone, p.year, p.month, 1).getTime() - 1),
      };
    case "all":
      return {};
    case "custom":
      return {
        from: parseZonedDay(custom?.from, timeZone),
        to: parseZonedDay(custom?.to, timeZone, true),
      };
  }
}
