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

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * Resolves a preset (or an explicit custom from/to pair) to a concrete
 * `{ from, to }` — both ends inclusive, `undefined` meaning unbounded
 * ("all" has no lower bound; a custom range with only one side filled
 * leaves the other open). `custom` ignores `now` entirely and just
 * echoes back `customFrom`/`customTo` as whole days.
 */
export function resolveDateRangePreset(
  preset: DateRangePreset,
  now: Date = new Date(),
  custom?: { from?: string; to?: string }
): ResolvedDateRange {
  switch (preset) {
    case "today":
      return { from: startOfDay(now), to: endOfDay(now) };
    case "yesterday": {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    }
    case "7d":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: endOfDay(now) };
    case "30d":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), to: endOfDay(now) };
    case "90d":
      return { from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89)), to: endOfDay(now) };
    case "this-month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
    case "last-month":
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
      };
    case "all":
      return {};
    case "custom": {
      const from = custom?.from ? new Date(`${custom.from}T00:00:00`) : undefined;
      const to = custom?.to ? new Date(`${custom.to}T23:59:59.999`) : undefined;
      return {
        from: from && !Number.isNaN(from.getTime()) ? from : undefined,
        to: to && !Number.isNaN(to.getTime()) ? to : undefined,
      };
    }
  }
}
